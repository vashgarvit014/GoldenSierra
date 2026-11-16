import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { env } from '../env';
import {
  NetworkPolicyError,
  allowHttp,
  assertHostPermitted,
  assertUrlShape,
  resolvePublic,
  systemResolver,
  type ResolvedAddress,
  type Resolver,
} from './policy';

/**
 * The only way crawler code touches the network.
 *
 * Per request (and again for every redirect hop):
 *   1. screen the URL shape        scheme, credentials, internal names, IP literals
 *   2. apply denylist / restriction
 *   3. resolve DNS and require every answer to be a public address
 *   4. connect ONLY to those validated addresses (the socket's lookup is pinned),
 *      so a second DNS answer cannot redirect the connection (DNS rebinding)
 *   5. refuse unsafe redirects (non-http(s), https→http, out of scope, too many)
 *   6. enforce a deadline, a response-size cap (on *decompressed* bytes) and a
 *      content-type allowlist before the body is read
 */

export type SafeFetchErrorCode =
  | 'timeout'
  | 'too_large'
  | 'bad_content_type'
  | 'too_many_redirects'
  | 'unsafe_redirect'
  | 'redirect_out_of_scope'
  | 'out_of_scope'
  | 'network';

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: SafeFetchErrorCode,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export type SafeFetchOptions = {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Overall deadline across all redirect hops. */
  timeoutMs?: number;
  /** Cap on the decompressed body. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Response content types accepted; others abort before the body is read. */
  allowedContentTypes?: RegExp[];
  /** Return false for URLs outside the source's approved crawl scope (checked on every hop). */
  inScope?: (url: URL) => boolean;
  /** Injectable for tests. */
  resolver?: Resolver;
  /** Injectable for tests: performs one HTTP exchange against already-validated addresses. */
  transport?: typeof requestOnce;
};

export type SafeResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  redirects: string[];
  address: string;
  text(): string;
};

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * A `lookup` that can only answer with the addresses we already validated.
 * Handing this to the socket means the connection cannot be steered by a
 * later (rebound) DNS answer.
 */
export function createPinnedLookup(addresses: ResolvedAddress[]) {
  return (
    _hostname: string,
    options: { family?: number | string; all?: boolean } | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ): void => {
    const opts = typeof options === 'object' && options ? options : {};
    const wanted = Number(opts.family ?? 0);
    const usable = addresses.filter((a) => !wanted || a.family === wanted);
    if (usable.length === 0) {
      callback(Object.assign(new Error('No validated address for the requested family'), { code: 'ENOTFOUND' }));
      return;
    }
    if (opts.all) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, usable[0]!.address, usable[0]!.family);
  };
}

function decoder(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function requestOnce(
  url: URL,
  addresses: ResolvedAddress[],
  opts: Required<Pick<SafeFetchOptions, 'maxBytes'>> & SafeFetchOptions,
  deadline: number,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        agent: false, // no connection reuse across validated hosts
        lookup: createPinnedLookup(addresses) as never,
        servername: net.isIP(host) ? undefined : host,
        headers: {
          'User-Agent': env.CRAWL_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/pdf;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          ...opts.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');

        if (REDIRECT.has(status) || (opts.method ?? 'GET') === 'HEAD') {
          res.resume();
          return done(() => resolve({ status, headers, body: Buffer.alloc(0) }));
        }

        const contentType = (headers['content-type'] ?? '').toLowerCase();
        if (status < 400 && opts.allowedContentTypes && !opts.allowedContentTypes.some((re) => re.test(contentType))) {
          res.destroy();
          return done(() => reject(new SafeFetchError(`Unsupported content type "${contentType || 'unknown'}"`, 'bad_content_type', url.toString())));
        }
        const declared = Number(headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return done(() => reject(new SafeFetchError(`Response is ${declared} bytes, over the ${opts.maxBytes}-byte limit`, 'too_large', url.toString())));
        }

        const inflater = decoder(headers['content-encoding']);
        const source: NodeJS.ReadableStream = inflater ? res.pipe(inflater) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        source.on('data', (chunk: Buffer) => {
          total += chunk.length; // decompressed bytes: a small gzip cannot expand past the cap
          if (total > opts.maxBytes) {
            res.destroy();
            inflater?.destroy();
            return done(() => reject(new SafeFetchError(`Response exceeded the ${opts.maxBytes}-byte limit`, 'too_large', url.toString())));
          }
          chunks.push(chunk);
        });
        source.on('end', () => done(() => resolve({ status, headers, body: Buffer.concat(chunks) })));
        source.on('error', (err) => done(() => reject(new SafeFetchError(`Could not read response: ${err.message}`, 'network', url.toString()))));
        res.on('error', (err) => done(() => reject(new SafeFetchError(`Connection error: ${err.message}`, 'network', url.toString()))));
      },
    );

    const timer = setTimeout(
      () => {
        req.destroy();
        done(() => reject(new SafeFetchError('Request timed out', 'timeout', url.toString())));
      },
      Math.max(1, deadline - Date.now()),
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ? ` [${err.code}]` : '';
      done(() => reject(new SafeFetchError(`${err.message}${code}`, 'network', url.toString())));
    });
    req.end();
  });
}

function parse(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new NetworkPolicyError('That is not a valid URL.', 'invalid_url');
  }
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const resolver = options.resolver ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? env.CRAWL_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? env.CRAWL_MAX_PAGE_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? env.CRAWL_TIMEOUT_MS);

  let url = parse(rawUrl);
  const redirects: string[] = [];

  for (let hop = 0; ; hop++) {
    assertUrlShape(url);
    await assertHostPermitted(url.hostname);
    if (options.inScope && !options.inScope(url)) {
      throw new SafeFetchError(
        hop === 0
          ? `${url.hostname} is outside this source's crawl scope`
          : `Redirected to ${url.hostname}, which is outside this source's crawl scope`,
        hop === 0 ? 'out_of_scope' : 'redirect_out_of_scope',
        url.toString(),
      );
    }

    const addresses = await resolvePublic(url.hostname, resolver);
    const res = await (options.transport ?? requestOnce)(url, addresses, { ...options, maxBytes }, deadline);

    const location = res.headers.location;
    if (REDIRECT.has(res.status) && location) {
      if (hop >= maxRedirects) {
        throw new SafeFetchError(`Too many redirects (more than ${maxRedirects})`, 'too_many_redirects', rawUrl);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SafeFetchError('Redirect to an invalid URL', 'unsafe_redirect', url.toString());
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new SafeFetchError(`Redirect to a non-HTTP(S) protocol (${next.protocol})`, 'unsafe_redirect', url.toString());
      }
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new SafeFetchError('Redirect downgrades from HTTPS to HTTP', 'unsafe_redirect', url.toString());
      }
      redirects.push(url.toString());
      url = next;
      continue;
    }

    const contentType = (res.headers['content-type'] ?? '').toLowerCase();
    return {
      url: url.toString(),
      status: res.status,
      headers: res.headers,
      contentType,
      body: res.body,
      redirects,
      address: addresses[0]!.address,
      text() {
        const charset = contentType.match(/charset=([^;\s]+)/)?.[1]?.replace(/["']/g, '') ?? 'utf-8';
        try {
          return new TextDecoder(charset).decode(res.body);
        } catch {
          return new TextDecoder('utf-8').decode(res.body);
        }
      },
    };
  }
}

export { allowHttp };
