import { describe, expect, it, vi } from 'vitest';
import { DelayedError, UnrecoverableError } from 'bullmq';
import {
  InvalidPdfUrlError,
  JobInFlightError,
  STALE_RUN_MS,
  decideClaim,
  describeError,
  errorChain,
  isPermanentJobError,
  scrubSecrets,
  validatePdfUrl,
} from '@/lib/ingest/safety';
import { MAX_DEFERRALS, processDelivery, type DeliveryJob } from '@/lib/ingest/delivery';

describe('describeError', () => {
  it('reports the underlying cause and code, not just "fetch failed"', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    const err = new TypeError('fetch failed', { cause });
    const text = describeError(err);
    expect(text).toContain('fetch failed');
    expect(text).toContain('getaddrinfo ENOTFOUND example.invalid');
    expect(errorChain(err).map((l) => l.code)).toContain('ENOTFOUND');
  });

  it('appends a code that the message does not already contain', () => {
    const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    expect(describeError(err)).toBe('Unique constraint failed [P2002]');
  });

  it('survives cycles and non-errors', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(describeError(a)).toBe('a');
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(undefined)).toBe('Unknown error');
  });

  it('never lets credentials through', () => {
    const secrets = [
      'postgresql://gs:hunter2@localhost:5433/db',
      'https://user:pa55word@host.example/file.pdf',
      'Authorization: Bearer abcdef1234567890abcdef',
      'https://x.example/a.pdf?api_key=SUPERSECRETVALUE&page=2',
      'token=abc123def456',
      'sk_72a3c0ffee11223344556677',
    ];
    for (const s of secrets) {
      const out = describeError(new Error(`failed: ${s}`, { cause: new Error(s) }));
      expect(out).not.toMatch(/hunter2|pa55word|abcdef1234567890|SUPERSECRETVALUE|abc123def456|72a3c0ffee/);
      expect(out).toContain('[redacted]');
    }
    expect(scrubSecrets('https://host.example/a.pdf?page=2')).toBe('https://host.example/a.pdf?page=2');
  });

  it('bounds the length', () => {
    expect(describeError(new Error('x'.repeat(5000))).length).toBe(2000);
  });
});

describe('validatePdfUrl', () => {
  it('accepts http and https', () => {
    expect(validatePdfUrl('https://goldensierra.com/a.pdf')).toBe('https://goldensierra.com/a.pdf');
    expect(validatePdfUrl('  http://127.0.0.1:8080/x.pdf ')).toBe('http://127.0.0.1:8080/x.pdf');
  });

  it.each([
    ['upload://file.pdf', /http or https/],
    ['ftp://host/a.pdf', /http or https/],
    ['file:///etc/passwd', /http or https/],
    ['javascript:alert(1)', /http or https/],
    ['data:application/pdf;base64,AAAA', /http or https/],
    ['not a url', /valid absolute URL/],
    ['/relative/a.pdf', /valid absolute URL/],
    ['https://user:pw@host/a.pdf', /credentials/],
    ['', /required/],
  ])('rejects %s', (input, message) => {
    expect(() => validatePdfUrl(input)).toThrow(InvalidPdfUrlError);
    expect(() => validatePdfUrl(input)).toThrow(message);
  });

  it('rejects non-strings', () => {
    expect(() => validatePdfUrl(undefined)).toThrow(InvalidPdfUrlError);
    expect(() => validatePdfUrl(42)).toThrow(InvalidPdfUrlError);
  });

  it('does not echo embedded credentials back', () => {
    try {
      validatePdfUrl('https://user:pw@host/a.pdf');
    } catch (e) {
      expect((e as Error).message).not.toContain('pw@');
    }
  });
});

describe('decideClaim — delivery decisions', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const ago = (ms: number) => new Date(now - ms);

  it('takes queued and failed rows (a retry after failure)', () => {
    expect(decideClaim({ status: 'QUEUED', startedAt: null }, now).kind).toBe('claimable');
    expect(decideClaim({ status: 'FAILED', startedAt: ago(1000) }, now).kind).toBe('claimable');
  });

  it('acknowledges finished rows', () => {
    expect(decideClaim({ status: 'COMPLETED', startedAt: ago(1000) }, now)).toEqual({ kind: 'terminal', status: 'COMPLETED' });
    expect(decideClaim({ status: 'CANCELLED', startedAt: null }, now).kind).toBe('terminal');
  });

  it('does NOT treat a live RUNNING row as done — it must be retried', () => {
    const d = decideClaim({ status: 'RUNNING', startedAt: ago(60_000) }, now);
    expect(d.kind).toBe('in_flight');
    if (d.kind === 'in_flight') expect(d.retryAfterMs).toBe(STALE_RUN_MS - 60_000);
  });

  it('reclaims a RUNNING row whose worker died', () => {
    expect(decideClaim({ status: 'RUNNING', startedAt: ago(STALE_RUN_MS + 1) }, now).kind).toBe('claimable');
    expect(decideClaim({ status: 'RUNNING', startedAt: null }, now).kind).toBe('claimable');
  });
});

describe('processDelivery — queue semantics', () => {
  const fakeJob = (data: { jobId: string; deferrals?: number }) => {
    const job = {
      data,
      attemptsMade: 0,
      updateData: vi.fn(async (d: typeof data) => void (job.data = d)),
      moveToDelayed: vi.fn(async () => undefined),
    };
    return job as typeof job & DeliveryJob;
  };

  it('completes on a normal run', async () => {
    const job = fakeJob({ jobId: 'j1' });
    await expect(processDelivery(job, 't', async () => undefined)).resolves.toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('defers (not completes) when the row is owned by a live run', async () => {
    const job = fakeJob({ jobId: 'j1' });
    const run = async () => {
      throw new JobInFlightError('j1', 10 * 60_000);
    };
    await expect(processDelivery(job, 'tok', run, () => 1_000)).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(1_000 + 5 * 60_000, 'tok'); // capped at 5 min
    expect(job.data.deferrals).toBe(1);
  });

  it('gives up after bounded deferrals rather than looping forever', async () => {
    const job = fakeJob({ jobId: 'j1', deferrals: MAX_DEFERRALS });
    const run = async () => {
      throw new JobInFlightError('j1', 1000);
    };
    const err = await processDelivery(job, 't', run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('fails permanent input errors without retrying', async () => {
    const job = fakeJob({ jobId: 'j1' });
    const run = async () => {
      validatePdfUrl('upload://x.pdf');
    };
    const err = await processDelivery(job, 't', run).catch((e: unknown) => e);
    expect(isPermanentJobError(new InvalidPdfUrlError('x'))).toBe(true);
    expect(err).toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows ordinary failures so BullMQ retries them', async () => {
    const job = fakeJob({ jobId: 'j1' });
    const boom = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND h'), { code: 'ENOTFOUND' }) });
    const err = await processDelivery(job, 't', async () => Promise.reject(boom)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('fetch failed ← getaddrinfo ENOTFOUND h'); // cause survives into failedReason
    expect((err as Error).cause).toBe(boom);
  });
});

import { afterEach } from 'vitest';
import { SsrfBlockedError, isPrivateAddress } from '@/lib/ingest/safety';
import { fetchAndExtractPdf } from '@/lib/ingest/pdf';

describe('SSRF protection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '[::1]',
  ])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'treats %s as public',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it.each([
    'http://localhost/a.pdf', 'http://127.0.0.1:3000/a.pdf', 'http://10.0.0.1/a.pdf',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/a.pdf', 'http://db.internal/a.pdf',
    'http://foo.localhost/a.pdf', 'http://printer.local/a.pdf',
  ])('rejects %s when the guard is on', (url) => {
    vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
    expect(() => validatePdfUrl(url)).toThrow(SsrfBlockedError);
    expect(() => validatePdfUrl(url)).toThrow(InvalidPdfUrlError); // permanent, never retried
  });

  it('still accepts public hosts when the guard is on', () => {
    vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
    expect(validatePdfUrl('https://goldensierra.com/a.pdf')).toBe('https://goldensierra.com/a.pdf');
    expect(validatePdfUrl('http://8.8.8.8/a.pdf')).toBe('http://8.8.8.8/a.pdf');
  });

  it('refuses a public URL that redirects to an internal address', async () => {
    vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAndExtractPdf('http://8.8.8.8/a.pdf')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the internal hop was never requested
  });

  it('bounds redirect chains', async () => {
    vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://8.8.4.4/loop.pdf' } })));
    await expect(fetchAndExtractPdf('http://8.8.8.8/a.pdf')).rejects.toThrow(/Too many redirects/);
  });
});
