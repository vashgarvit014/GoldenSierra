import { assertUrlShape, NetworkPolicyError } from '../net/policy';

export { isPrivateAddress } from '../net/ip';

/**
 * Small helpers shared by the API, the pipeline and the worker.
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
  if (parsed.protocol === 'upload:') {
    throw new InvalidPdfUrlError('"upload://" is an internal identifier for uploaded files; upload the file through the upload endpoint instead');
  }
  try {
    // Scheme, credentials, internal names and private IP literals — the same rules every fetch applies.
    assertUrlShape(parsed);
  } catch (err) {
    if (err instanceof NetworkPolicyError) {
      if (err.code === 'blocked_host' || err.code === 'blocked_address') throw new SsrfBlockedError(err.message);
      throw new InvalidPdfUrlError(err.message);
    }
    throw err;
  }
  return parsed.toString();
}

export class SsrfBlockedError extends InvalidPdfUrlError {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
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
  // Policy refusals (denylist, private address) and bad input never improve on retry.
  return err instanceof InvalidPdfUrlError || err instanceof NetworkPolicyError;
}
