import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isPrivateAddress } from '@/lib/net/ip';
import {
  NetworkPolicyError,
  assertHostPermitted,
  assertUrlShape,
  resetPolicyCache,
  resolvePublic,
  type Resolver,
} from '@/lib/net/policy';
import { SafeFetchError, createPinnedLookup, safeFetch } from '@/lib/net/safe-fetch';
import { resetEnvCache } from '@/lib/env';

/** The suite-wide fixture switch is off for these tests; each test opts in where it needs loopback. */
const strict = () => {
  vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
  vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '0');
};
/** Sets env vars and makes the app re-read them. */
const setEnv = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  resetEnvCache();
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetPolicyCache();
});

describe('address classification', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '240.0.0.1', '198.18.0.9',
    '192.0.2.5', '198.51.100.5', '203.0.113.5', '192.0.0.8',
    '::1', '::', 'fe80::1', 'fe80::abcd%en0', 'fd00:ec2::254', 'fc00::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::', '2001:db8::1', '2001:0:4136:e378::1', '100::1', '[::1]',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::',
  ])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('URL shape policy', () => {
  it('requires HTTPS by default', () => {
    strict();
    expect(() => assertUrlShape(new URL('http://example.org/'))).toThrow(/HTTPS/);
    expect(() => assertUrlShape(new URL('https://example.org/'))).not.toThrow();
  });

  it('allows plain HTTP only when the deployment opts in', () => {
    strict();
    setEnv({ CRAWL_ALLOW_HTTP: 'true' });
    expect(() => assertUrlShape(new URL('http://example.org/'))).not.toThrow();
  });

  it.each([
    ['ftp://example.org/', 'bad_scheme'],
    ['file:///etc/passwd', 'bad_scheme'],
    ['https://user:pw@example.org/', 'credentials'],
    ['https://localhost/', 'blocked_host'],
    ['https://app.localhost/', 'blocked_host'],
    ['https://printer.local/', 'blocked_host'],
    ['https://db.internal/', 'blocked_host'],
    ['https://metadata.google.internal/', 'blocked_host'],
    ['https://127.0.0.1/', 'blocked_address'],
    ['https://10.0.0.5/', 'blocked_address'],
    ['https://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['https://[::1]/', 'blocked_address'],
    ['https://[fd00::1]/', 'blocked_address'],
    ['https://[::ffff:7f00:1]/', 'blocked_address'],
    ['https://2130706433/', 'blocked_address'], // decimal 127.0.0.1
    ['https://0x7f.1/', 'blocked_address'],
    ['https://0177.0.0.1/', 'blocked_address'], // octal
  ])('rejects %s (%s)', (url, code) => {
    strict();
    const parsed = new URL(url);
    try {
      assertUrlShape(parsed);
      throw new Error('not rejected');
    } catch (e) {
      expect(e).toBeInstanceOf(NetworkPolicyError);
      expect((e as NetworkPolicyError).code).toBe(code);
    }
  });

  it('does not echo credentials back in the error', () => {
    strict();
    try {
      assertUrlShape(new URL('https://admin:s3cret@example.org/'));
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cret');
    }
  });
});

describe('denylist and deployment restriction', () => {
  it('refuses denied hosts and their subdomains', async () => {
    strict();
    setEnv({ CRAWL_DENIED_HOSTS: 'bad.example,*.evil.test' });
    await expect(assertHostPermitted('bad.example')).rejects.toMatchObject({ code: 'denied_host' });
    await expect(assertHostPermitted('www.bad.example')).rejects.toMatchObject({ code: 'denied_host' });
    await expect(assertHostPermitted('x.evil.test')).rejects.toMatchObject({ code: 'denied_host' });
    await expect(assertHostPermitted('notbad.example')).resolves.toBeUndefined();
    await expect(assertHostPermitted('good.example')).resolves.toBeUndefined();
  });

  it('is unrestricted by default, and restricts when the deployment says so', async () => {
    strict();
    await expect(assertHostPermitted('any-public-site.example')).resolves.toBeUndefined();
    setEnv({ CRAWL_RESTRICT_HOSTS: 'only.example' });
    await expect(assertHostPermitted('only.example')).resolves.toBeUndefined();
    await expect(assertHostPermitted('www.only.example')).resolves.toBeUndefined();
    await expect(assertHostPermitted('other.example')).rejects.toMatchObject({ code: 'not_in_restriction' });
  });
});

describe('DNS validation', () => {
  const pub: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

  it('accepts a host whose answers are all public', async () => {
    strict();
    await expect(resolvePublic('example.org', pub)).resolves.toHaveLength(1);
  });

  it('rejects a name that resolves to a private address', async () => {
    strict();
    const priv: Resolver = async () => [{ address: '10.0.0.7', family: 4 }];
    await expect(resolvePublic('looks-public.example', priv)).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('rejects when ANY answer is private (mixed records)', async () => {
    strict();
    const mixed: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(resolvePublic('mixed.example', mixed)).rejects.toMatchObject({ code: 'blocked_address' });
    const v6: Resolver = async () => [{ address: '::ffff:192.168.1.1', family: 6 }];
    await expect(resolvePublic('v6.example', v6)).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('reports DNS failure clearly', async () => {
    strict();
    const fail: Resolver = async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    };
    await expect(resolvePublic('missing.example', fail)).rejects.toMatchObject({ code: 'dns_failure' });
  });

  it('an IP literal is checked directly and never resolved', async () => {
    strict();
    const never: Resolver = async () => {
      throw new Error('resolver must not be called');
    };
    await expect(resolvePublic('192.168.0.1', never)).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(resolvePublic('8.8.8.8', never)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
  });
});

describe('connection pinning', () => {
  it('can only answer with validated addresses', async () => {
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800::1', family: 6 }]);
    const one = await new Promise<unknown>((r) => lookup('x', {}, (_e, a, f) => r([a, f])));
    expect(one).toEqual(['93.184.216.34', 4]);
    const all = await new Promise<unknown>((r) => lookup('x', { all: true }, (_e, a) => r(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800::1', family: 6 }]);
    const v6 = await new Promise<unknown>((r) => lookup('x', { family: 6 }, (_e, a) => r(a)));
    expect(v6).toBe('2606:2800::1');
    const none = await new Promise<unknown>((r) => createPinnedLookup([{ address: '1.1.1.1', family: 4 }])('x', { family: 6 }, (e) => r(e)));
    expect(none).toBeInstanceOf(Error);
  });
});

describe('safeFetch — redirects, rebinding and scope (no sockets)', () => {
  const pub: Resolver = async (h) => [{ address: h.startsWith('private') ? '10.9.9.9' : '93.184.216.34', family: 4 }];
  const ok = (url: URL) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>hi</p>') });
  const redirectTo = (location: string) => ({ status: 302, headers: { location }, body: Buffer.alloc(0) });

  it('follows a safe redirect chain and reports it', async () => {
    strict();
    const calls: string[] = [];
    const transport = async (url: URL) => {
      calls.push(url.toString());
      return url.pathname === '/old' ? redirectTo('/new') : ok(url);
    };
    const res = await safeFetch('https://example.org/old', { resolver: pub, transport });
    expect(res.url).toBe('https://example.org/new');
    expect(res.redirects).toEqual(['https://example.org/old']);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['https://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['https://10.0.0.1/', 'blocked_address'],
    ['https://[::1]/', 'blocked_address'],
    ['https://private.example/', 'blocked_address'], // DNS → private, found on the redirect hop
    ['https://localhost/', 'blocked_host'],
  ])('revalidates redirect targets: %s is refused', async (location) => {
    strict();
    const hits: string[] = [];
    const transport = async (url: URL) => {
      hits.push(url.hostname);
      return url.hostname === 'example.org' ? redirectTo(location) : ok(url);
    };
    await expect(safeFetch('https://example.org/', { resolver: pub, transport })).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(hits).toEqual(['example.org']); // the unsafe hop was never requested
  });

  it('an https page cannot bounce to http://169.254.169.254 (downgrade is refused first)', async () => {
    strict();
    const hits: string[] = [];
    const transport = async (url: URL) => {
      hits.push(url.hostname);
      return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: Buffer.alloc(0) };
    };
    await expect(safeFetch('https://example.org/', { resolver: pub, transport })).rejects.toThrow();
    expect(hits).toEqual(['example.org']);
  });

  it.each(['ftp://example.org/x', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.org/'])(
    'refuses a redirect to %s',
    async (location) => {
      strict();
      const transport = async () => redirectTo(location);
      await expect(safeFetch('https://example.org/', { resolver: pub, transport })).rejects.toMatchObject({ code: 'unsafe_redirect' });
    },
  );

  it('refuses an HTTPS → HTTP downgrade even when plain HTTP is otherwise allowed', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    const transport = async () => redirectTo('http://example.org/insecure');
    await expect(safeFetch('https://example.org/', { resolver: pub, transport })).rejects.toMatchObject({ code: 'unsafe_redirect' });
  });

  it('bounds redirect chains', async () => {
    strict();
    const transport = async (url: URL) => redirectTo(`/r${Number(url.pathname.slice(2) || 0) + 1}`);
    await expect(safeFetch('https://example.org/', { resolver: pub, transport, maxRedirects: 3 })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('resolves each hop exactly once and connects only to what it validated (no rebinding window)', async () => {
    strict();
    let resolutions = 0;
    const resolver: Resolver = async () => {
      resolutions++;
      // A rebinding resolver would answer differently the second time.
      return [{ address: resolutions === 1 ? '93.184.216.34' : '10.0.0.1', family: 4 }];
    };
    let connectedTo: string[] = [];
    const transport = async (_url: URL, addresses: { address: string }[]) => {
      connectedTo = addresses.map((a) => a.address);
      return ok(_url);
    };
    await safeFetch('https://example.org/', { resolver, transport });
    expect(resolutions).toBe(1);
    expect(connectedTo).toEqual(['93.184.216.34']);
  });

  it('enforces the per-source scope on the first request and on every redirect', async () => {
    strict();
    const inScope = (u: URL) => u.hostname === 'example.org';
    const transport = async () => redirectTo('https://other.example/');
    await expect(safeFetch('https://elsewhere.example/', { resolver: pub, transport, inScope })).rejects.toMatchObject({ code: 'out_of_scope' });
    await expect(safeFetch('https://example.org/', { resolver: pub, transport, inScope })).rejects.toMatchObject({ code: 'redirect_out_of_scope' });
  });
});

describe('safeFetch — real sockets against a fixture server', () => {
  let server: http.Server;
  let base = '';
  let lastHost = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHost = String(req.headers.host);
      const path = req.url ?? '/';
      if (path === '/html') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>héllo</p>');
      if (path === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      if (path === '/big') return void res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(2_000_000));
      if (path === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync('<p>compressed ok</p>'));
        return;
      }
      if (path === '/bomb') {
        // ~10 KB on the wire, 50 MB when inflated.
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync(Buffer.alloc(50_000_000, 'a')));
        return;
      }
      if (path === '/slow') return void setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('late'), 3000);
      if (path === '/redir') return void res.writeHead(302, { location: '/html' }).end();
      res.writeHead(404, { 'content-type': 'text/html' }).end('nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('is blocked outright when private networks are not allowed (the production posture)', async () => {
    strict();
    await expect(safeFetch(`${base}/html`)).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it('the fixture override is ignored in production', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(safeFetch(`${base}/html`)).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it('fetches, decodes and follows a redirect when fixtures are enabled', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    const res = await safeFetch(`${base}/redir`, { allowedContentTypes: [/^text\/html/] });
    expect(res.status).toBe(200);
    expect(res.text()).toContain('héllo');
    expect(res.redirects).toHaveLength(1);
    expect(lastHost).toContain('127.0.0.1');
  });

  it('decompresses gzip', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    expect((await safeFetch(`${base}/gzip`)).text()).toBe('<p>compressed ok</p>');
  });

  it('rejects a disallowed content type before reading the body', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    await expect(safeFetch(`${base}/json`, { allowedContentTypes: [/^text\/html/] })).rejects.toMatchObject({ code: 'bad_content_type' });
  });

  it('enforces the size cap, including on decompressed bytes (gzip bomb)', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    await expect(safeFetch(`${base}/big`, { maxBytes: 1_000_000 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(safeFetch(`${base}/bomb`, { maxBytes: 1_000_000 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('enforces the deadline', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    await expect(safeFetch(`${base}/slow`, { timeoutMs: 400 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports a refused connection as a network error', async () => {
    vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '1');
    const err = await safeFetch('http://127.0.0.1:9/x', { timeoutMs: 3000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe('network');
  });
});
