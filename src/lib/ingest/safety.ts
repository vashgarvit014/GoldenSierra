/**
 * Small, dependency-free helpers shared by the API, the pipeline and the worker.
 */

// ───────────────────────── Error detail ─────────────────────────

/** Removes credentials from free text before it is logged or stored. */
export function scrubSecrets(text: string): string {
  return (
    text
      // scheme://user:pass@host  →  scheme://[redacted]@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
      // Authorization: Bearer abc / Basic abc
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
      // ?api_key=…  &token=…  password=…
      .replace(
        /([?&;\s"']?(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|pwd|sig|signature|auth)["']?\s*[=:]\s*)[^\s&"',;]+/gi,
        '$1[redacted]',
      )
      // provider-style keys (sk_…, sk-…, pk_…, xox…, ghp_…)
      .replace(/\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{12,}\b/g, '[redacted]')
      .replace(/\b(?:ghp|gho|xox[abp])[_-]?[A-Za-z0-9-]{12,}\b/g, '[redacted]')
  );
}

export type ErrorLink = { name: string; code?: string; message: string };

/** Walks `err.cause` (bounded) so "fetch failed" also reports *why* it failed. */
export function errorChain(err: unknown, maxDepth = 5): ErrorLink[] {
  const chain: ErrorLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && chain.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object') {
      const e = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errno?: unknown };
      const code = e.code ?? undefined;
      chain.push({
        name: typeof e.name === 'string' ? e.name : 'Error',
        code: code === undefined ? undefined : String(code),
        message: scrubSecrets(typeof e.message === 'string' ? e.message : String(current)),
      });
      current = e.cause;
    } else {
      chain.push({ name: 'Error', message: scrubSecrets(String(current)) });
      break;
    }
  }
  return chain;
}

/**
 * One-line, credential-free description including the whole cause chain:
 *   "fetch failed ← getaddrinfo ENOTFOUND host [ENOTFOUND]"
 */
export function describeError(err: unknown, maxLength = 2000): string {
  const chain = errorChain(err);
  if (chain.length === 0) return 'Unknown error';
  const text = chain
    .map((link) => {
      const code = link.code && !link.message.includes(link.code) ? ` [${link.code}]` : '';
      return `${link.message}${code}`;
    })
    .join(' ← ');
  return text.slice(0, maxLength);
}

// ───────────────────────── PDF url validation ─────────────────────────

export class InvalidPdfUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPdfUrlError';
  }
}

// ───────────────────────── SSRF protection ─────────────────────────

/** Tests and local development may fetch loopback fixtures; production must not. */
function allowPrivate(): boolean {
  return process.env.ALLOW_PRIVATE_FETCH === '1';
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    const [a, b, c] = v.split('.').map(Number) as [number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v.includes(':')) {
    return (
      v === '::' || v === '::1' ||
      /^f[cd]/.test(v) || // fc00::/7 unique local
      /^fe[89ab]/.test(v) || // fe80::/10 link-local
      v.startsWith('ff') // multicast
    );
  }
  return false;
}

export class SsrfBlockedError extends InvalidPdfUrlError {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Cheap, synchronous screen: literal IPs and obviously internal host names. */
export function assertPublicHostname(hostname: string): void {
  if (allowPrivate()) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_NAMES.test(host) || isPrivateAddress(host)) {
    throw new SsrfBlockedError('PDF url points at a private or internal address, which is not allowed');
  }
}

/** Resolves the host and refuses it if any answer is a private address. */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (allowPrivate()) return;
  const { hostname } = new URL(raw);
  assertPublicHostname(hostname);
  const { lookup } = await import('node:dns/promises');
  const answers = await lookup(hostname, { all: true }).catch(() => []); // unresolvable: fetch reports it
  if (answers.some((a) => isPrivateAddress(a.address))) {
    throw new SsrfBlockedError('PDF url resolves to a private or internal address, which is not allowed');
  }
}

/**
 * A PDF_INGEST job fetches over the network, so its only valid input is an
 * absolute http(s) URL. `upload://` is the internal identifier of a document
 * that arrived as a file; it is not fetchable and must never become a job.
 */
export function validatePdfUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new InvalidPdfUrlError('A PDF url is required');
  const value = raw.trim();
  if (value.length > 2000) throw new InvalidPdfUrlError('PDF url is too long');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidPdfUrlError('PDF url is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidPdfUrlError(
      `PDF url must use http or https (got "${parsed.protocol.replace(':', '')}://"); uploaded files go through the upload endpoint`,
    );
  }
  if (!parsed.hostname) throw new InvalidPdfUrlError('PDF url has no host');
  if (parsed.username || parsed.password) {
    throw new InvalidPdfUrlError('PDF url must not embed credentials');
  }
  assertPublicHostname(parsed.hostname);
  return parsed.toString();
}

// ───────────────────────── Claim decision ─────────────────────────

/** A job running longer than this is presumed dead and may be reclaimed. */
export const STALE_RUN_MS = 30 * 60 * 1000;

export type ClaimRow = { status: string; startedAt: Date | null };

export type ClaimDecision =
  | { kind: 'claimable' }
  | { kind: 'terminal'; status: string }
  | { kind: 'in_flight'; retryAfterMs: number };

/**
 * What a delivery of a job should do, given the row's current state.
 *
 *  - QUEUED / FAILED / a RUNNING row whose owner went quiet → take it
 *  - COMPLETED / CANCELLED → nothing left to do; acknowledging is correct
 *  - RUNNING and recent → someone else may be working on it. This is *not*
 *    success: acknowledging it would mark the queue job done while the row
 *    stays RUNNING for as long as it takes to go stale, and nothing would
 *    ever pick it up again.
 */
export function decideClaim(row: ClaimRow, now = Date.now()): ClaimDecision {
  switch (row.status) {
    case 'QUEUED':
    case 'FAILED':
      return { kind: 'claimable' };
    case 'RUNNING': {
      const started = row.startedAt?.getTime() ?? 0;
      const age = now - started;
      if (age >= STALE_RUN_MS) return { kind: 'claimable' };
      return { kind: 'in_flight', retryAfterMs: STALE_RUN_MS - age };
    }
    default:
      return { kind: 'terminal', status: row.status };
  }
}

/** Thrown when a job is owned by a live run; callers must retry, not ack. */
export class JobInFlightError extends Error {
  constructor(
    readonly jobId: string,
    readonly retryAfterMs: number,
  ) {
    super(`Ingestion job ${jobId} is already running; delivery deferred`);
    this.name = 'JobInFlightError';
  }
}

/** Errors a retry cannot fix; the worker fails these without another attempt. */
export function isPermanentJobError(err: unknown): boolean {
  return err instanceof InvalidPdfUrlError;
}
