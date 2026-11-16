import { env } from '../env';
import { logger } from '../logger';
import { isIpLiteral, isPrivateAddress, looksLikeObfuscatedIPv4 } from './ip';

/**
 * Which hosts the crawler may talk to.
 *
 * There is deliberately no hard-coded domain list. Any public website may be
 * registered by an authorised administrator; what is enforced instead is:
 *
 *   1. the network is public       (no loopback / private / link-local / metadata)
 *   2. an optional deployment restriction  (CRAWL_RESTRICT_HOSTS, empty = none)
 *   3. an administrator denylist           (CRAWL_DENIED_HOSTS + the stored setting)
 *
 * Tests may reach loopback fixtures, but never in production.
 */

export class NetworkPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'bad_scheme'
      | 'credentials'
      | 'blocked_host'
      | 'blocked_address'
      | 'denied_host'
      | 'not_in_restriction'
      | 'dns_failure',
    readonly host: string | null = null,
  ) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

let warnedTestOverride = false;

/** Loopback/private fixtures are reachable only outside production and only when explicitly enabled. */
export function allowPrivateNetwork(): boolean {
  const on = process.env.CRAWL_TEST_ALLOW_PRIVATE === '1' || process.env.ALLOW_PRIVATE_FETCH === '1';
  if (!on) return false;
  if (process.env.NODE_ENV === 'production') {
    if (!warnedTestOverride) {
      warnedTestOverride = true;
      logger.error('Ignoring CRAWL_TEST_ALLOW_PRIVATE: it is never honoured in production');
    }
    return false;
  }
  return true;
}

/** Plain HTTP is a test/dev affordance; the default and production posture is HTTPS only. */
export function allowHttp(): boolean {
  return env.CRAWL_ALLOW_HTTP || allowPrivateNetwork();
}

const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|corp|home|localdomain|home\.arpa)$/i;
const METADATA_NAMES = /^(metadata(\.google)?\.internal|instance-data(\.ec2\.internal)?)$/i;

export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function hostMatches(host: string, entry: string): boolean {
  const e = canonicalHost(entry).replace(/^\*\./, '');
  return host === e || host.endsWith(`.${e}`);
}

// ── Administrator denylist (environment + stored setting) ──
let storedDenied: { at: number; hosts: string[] } | undefined;
const STORED_TTL_MS = 15_000;

async function storedDeniedHosts(): Promise<string[]> {
  if (storedDenied && Date.now() - storedDenied.at < STORED_TTL_MS) return storedDenied.hosts;
  let hosts: string[] = [];
  try {
    const { prisma } = await import('../db');
    const row = await prisma.systemConfig.findUnique({ where: { key: 'CRAWL_DENIED_HOSTS' } });
    if (Array.isArray(row?.value)) hosts = (row!.value as unknown[]).filter((h): h is string => typeof h === 'string');
  } catch {
    // The stored list is an additive control; if it cannot be read the
    // environment list still applies.
  }
  storedDenied = { at: Date.now(), hosts };
  return hosts;
}

export function resetPolicyCache(): void {
  storedDenied = undefined;
}

export async function deniedHosts(): Promise<string[]> {
  return [...env.CRAWL_DENIED_HOSTS, ...(await storedDeniedHosts())].map(canonicalHost).filter(Boolean);
}

/**
 * Synchronous screen on a parsed URL: scheme, credentials, and names/literals
 * that are never public. DNS-based checks happen separately in `resolvePublic`.
 */
export function assertUrlShape(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NetworkPolicyError(
      `Only http(s) URLs can be fetched (got "${url.protocol.replace(':', '')}:")`,
      'bad_scheme',
    );
  }
  if (url.protocol === 'http:' && !allowHttp()) {
    throw new NetworkPolicyError('This site must be reached over HTTPS; plain http:// is not accepted.', 'bad_scheme');
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError('URLs with embedded credentials are not accepted.', 'credentials');
  }
  const host = canonicalHost(url.hostname);
  if (!host) throw new NetworkPolicyError('The URL has no host.', 'invalid_url');
  if (allowPrivateNetwork()) return;
  if (INTERNAL_NAMES.test(host) || METADATA_NAMES.test(host)) {
    throw new NetworkPolicyError(`"${host}" is an internal or metadata host, which cannot be crawled.`, 'blocked_host', host);
  }
  if (looksLikeObfuscatedIPv4(host) || (isIpLiteral(host) && isPrivateAddress(host))) {
    throw new NetworkPolicyError(`"${host}" is a private, loopback or reserved address, which cannot be crawled.`, 'blocked_address', host);
  }
}

/** Denylist and optional deployment restriction. */
export async function assertHostPermitted(hostname: string): Promise<void> {
  const host = canonicalHost(hostname);
  if ((await deniedHosts()).some((d) => hostMatches(host, d))) {
    throw new NetworkPolicyError(`"${host}" is on this deployment's crawl denylist.`, 'denied_host', host);
  }
  const restrict = env.CRAWL_RESTRICT_HOSTS.map(canonicalHost).filter(Boolean);
  if (restrict.length && !restrict.some((r) => hostMatches(host, r))) {
    throw new NetworkPolicyError(
      `"${host}" is outside this deployment's restricted crawl scope (${restrict.join(', ')}).`,
      'not_in_restriction',
      host,
    );
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
};

/**
 * Resolves a host and requires *every* answer to be public. An attacker-controlled
 * name that returns one public and one private record is rejected outright rather
 * than hoping the resolver picks the safe one.
 */
export async function resolvePublic(hostname: string, resolver: Resolver = systemResolver): Promise<ResolvedAddress[]> {
  const host = canonicalHost(hostname);
  if (isIpLiteral(host)) {
    if (!allowPrivateNetwork() && isPrivateAddress(host)) {
      throw new NetworkPolicyError(`"${host}" is a private, loopback or reserved address.`, 'blocked_address', host);
    }
    return [{ address: host, family: host.includes(':') ? 6 : 4 }];
  }
  let answers: ResolvedAddress[];
  try {
    answers = await resolver(host);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'ERR';
    throw new NetworkPolicyError(`Could not resolve "${host}" (${code}).`, 'dns_failure', host);
  }
  if (answers.length === 0) throw new NetworkPolicyError(`"${host}" has no DNS records.`, 'dns_failure', host);
  if (!allowPrivateNetwork()) {
    const bad = answers.find((a) => isPrivateAddress(a.address));
    if (bad) {
      throw new NetworkPolicyError(
        `"${host}" resolves to a private or reserved address (${bad.address}), which cannot be crawled.`,
        'blocked_address',
        host,
      );
    }
  }
  return answers;
}
