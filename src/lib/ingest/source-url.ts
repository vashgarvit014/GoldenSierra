import { NetworkPolicyError, assertHostPermitted, assertUrlShape, resolvePublic, type Resolver } from '../net/policy';
import { normalizeUrl, scopeHostOf } from './crawler';

/**
 * Validates a website an administrator wants to register as a knowledge source.
 *
 * Nothing here consults a fixed list of domains. A site is acceptable when it is
 * a well-formed public HTTPS address that passes the deployment denylist (and
 * optional restriction) and whose DNS answers are all public addresses.
 */

export type SourceRejection =
  | 'invalid_url'
  | 'bad_scheme'
  | 'credentials'
  | 'blocked_host'
  | 'blocked_address'
  | 'denied_host'
  | 'not_in_restriction'
  | 'dns_failure';

export class SourceUrlError extends Error {
  constructor(
    message: string,
    readonly reason: SourceRejection,
    readonly host: string | null,
  ) {
    super(message);
    this.name = 'SourceUrlError';
  }
}

export type ValidatedSource = {
  /** Canonical crawl root. */
  url: string;
  host: string;
  /** The host this source is allowed to crawl (a leading "www." ignored). */
  scopeHost: string;
  addresses: string[];
};

const HINTS: Partial<Record<SourceRejection, string>> = {
  bad_scheme: 'Use an https:// address.',
  blocked_host: 'Only publicly reachable websites can be crawled; internal and local names are refused.',
  blocked_address: 'Only publicly routable addresses can be crawled; private, loopback, link-local and cloud-metadata addresses are refused.',
  dns_failure: 'Check the spelling of the domain, and that the site is publicly reachable.',
  denied_host: 'An administrator has blocked this domain from being crawled.',
  not_in_restriction: 'This deployment only allows crawling a restricted set of sites.',
};

export async function validateSourceUrl(raw: string, resolver?: Resolver): Promise<ValidatedSource> {
  const value = (raw ?? '').trim();
  if (!value) throw new SourceUrlError('Enter the website address to crawl.', 'invalid_url', null);
  if (value.length > 2000) throw new SourceUrlError('That URL is too long.', 'invalid_url', null);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SourceUrlError(
      'That is not a valid URL. Enter the full address, for example https://example.org/.',
      'invalid_url',
      null,
    );
  }

  try {
    assertUrlShape(parsed);
    await assertHostPermitted(parsed.hostname);
    const addresses = await resolvePublic(parsed.hostname, resolver);

    const canonical = normalizeUrl(parsed.toString());
    if (!canonical) throw new SourceUrlError('That URL could not be normalised.', 'invalid_url', null);
    // Keep "/" as the root path so https://x.org and https://x.org/ are one source.
    const url = new URL(canonical);
    if (url.pathname === '') url.pathname = '/';
    return {
      url: url.toString(),
      host: url.hostname,
      scopeHost: scopeHostOf(url.toString()),
      addresses: addresses.map((a) => a.address),
    };
  } catch (err) {
    if (err instanceof NetworkPolicyError) {
      const hint = HINTS[err.code];
      throw new SourceUrlError(hint ? `${err.message} ${hint}` : err.message, err.code, err.host);
    }
    throw err;
  }
}
