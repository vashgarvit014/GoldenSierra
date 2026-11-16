import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { crawl, RobotsUnavailableError, type CrawlPageResult, type CrawlTarget } from '@/lib/ingest/crawler';
import { NetworkPolicyError } from '@/lib/net/policy';
import { validateSourceUrl, SourceUrlError } from '@/lib/ingest/source-url';

/**
 * The crawler against a *virtual* website: no sockets, no DNS. Everything the
 * crawler does goes through safeFetch's transport, so these tests exercise the
 * real scope, robots, sitemap, duplicate, redirect and budget logic.
 */

type Reply = { status?: number; type?: string; body?: string; headers?: Record<string, string> };

const para = (n: number, tag = 'x') =>
  `<p>${Array.from({ length: n }, (_, i) => `word${tag}${i}`).join(' ')}</p>`;
const page = (title: string, body: string, extra = '') =>
  `<!doctype html><html><head><title>${title}</title>${extra}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

function web(map: Record<string, Reply | string>) {
  const hits: string[] = [];
  const transport = async (url: URL) => {
    const key = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
    hits.push(key);
    const r = map[key];
    if (r === undefined) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nf') };
    const reply: Reply = typeof r === 'string' ? { body: r } : r;
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.type ?? 'text/html; charset=utf-8', ...(reply.headers ?? {}) },
      body: Buffer.from(reply.body ?? ''),
    };
  };
  const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
  return { testing: { transport, resolver }, hits };
}

const target = (o: Partial<CrawlTarget> = {}): CrawlTarget => ({
  rootUrl: 'https://site.example/',
  maxDepth: 3,
  maxPages: 50,
  respectRobots: true,
  includePatterns: [],
  excludePatterns: [],
  ...o,
});

async function run(map: Record<string, Reply | string>, t = target()) {
  const w = web(map);
  const results: CrawlPageResult[] = [];
  const summary = await crawl(t, { onPage: (r) => void results.push(r) }, w.testing);
  return { summary, results, hits: w.hits };
}

const strictEnv = (vars: Record<string, string> = {}) => {
  vi.stubEnv('ALLOW_PRIVATE_FETCH', '0');
  vi.stubEnv('CRAWL_TEST_ALLOW_PRIVATE', '0');
  vi.stubEnv('CRAWL_DELAY_MS', '0');
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  resetEnvCache();
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe('crawl scope', () => {
  it('crawls internal links and never follows links to other domains', async () => {
    strictEnv();
    const { summary, hits } = await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /' },
      'https://site.example/': page('Home', `${para(60)}<a href="/about">About</a><a href="https://other.example/x">Elsewhere</a><a href="https://sub.site.example/y">Sub</a><a href="https://www.site.example/www">WWW</a>`),
      'https://site.example/about': page('About', para(60, 'a')),
      'https://www.site.example/www': page('WWW', para(60, 'w')),
    });
    expect(hits.some((h) => h.includes('other.example'))).toBe(false);
    expect(hits.some((h) => h.includes('sub.site.example'))).toBe(false);
    expect(summary.skippedOffScope).toBeGreaterThanOrEqual(2);
    expect(hits).toContain('https://site.example/about');
    expect(hits).toContain('https://www.site.example/www'); // www is the same site
  });

  it('a sitemap cannot widen scope', async () => {
    strictEnv();
    const { hits, summary } = await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /' },
      'https://site.example/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>https://site.example/in</loc></url><url><loc>https://evil.example/out</loc></url></urlset>' },
      'https://site.example/': page('Home', para(60)),
      'https://site.example/in': page('In', para(60, 'i')),
    });
    expect(hits).toContain('https://site.example/in');
    expect(hits.some((h) => h.includes('evil.example'))).toBe(false);
    expect(summary.sitemapUrls).toBe(1);
  });

  it('a redirect to another domain fails the page and is never requested', async () => {
    strictEnv();
    const { results, hits } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': { status: 302, headers: { location: 'https://elsewhere.example/landing' } },
      'https://elsewhere.example/landing': page('Landing', para(60)),
    });
    expect(hits.some((h) => h.includes('elsewhere.example/landing'))).toBe(false);
    const fail = results.find((r) => !r.ok);
    expect(fail && !fail.ok && fail.reason).toMatch(/outside this source's crawl scope/);
  });

  it('follows a redirect within scope (http→https upgrade and path move)', async () => {
    strictEnv();
    const { results } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', `${para(60)}<a href="/old">old</a>`),
      'https://site.example/old': { status: 301, headers: { location: '/new' } },
      'https://site.example/new': page('New', para(60, 'n')),
    });
    const ok = results.filter((r) => r.ok);
    expect(ok.some((r) => r.ok && r.page.url === 'https://site.example/new')).toBe(true);
  });
});

describe('robots.txt', () => {
  it('skips disallowed paths', async () => {
    strictEnv();
    const { hits, summary } = await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private' },
      'https://site.example/': page('Home', `${para(60)}<a href="/private/a">p</a><a href="/public">q</a>`),
      'https://site.example/public': page('Pub', para(60, 'p')),
      'https://site.example/private/a': page('Priv', para(60, 'z')),
    });
    expect(hits).not.toContain('https://site.example/private/a');
    expect(hits).toContain('https://site.example/public');
    expect(summary.skippedByRobots).toBe(1);
  });

  it('fetches nothing when robots.txt disallows the whole site', async () => {
    strictEnv();
    const { summary, hits } = await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /' },
      'https://site.example/': page('Home', para(60)),
    });
    expect(summary.robotsBlocked).toBe(true);
    expect(summary.visited).toBe(0);
    expect(hits).toEqual(['https://site.example/robots.txt']);
  });

  it('treats a missing robots.txt (404) as allow-all', async () => {
    strictEnv();
    const { summary } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', para(60)),
    });
    expect(summary.succeeded).toBe(1);
  });

  it('refuses to crawl when robots.txt cannot be confirmed (5xx)', async () => {
    strictEnv();
    await expect(
      run({ 'https://site.example/robots.txt': { status: 503 }, 'https://site.example/': page('Home', para(60)) }),
    ).rejects.toBeInstanceOf(RobotsUnavailableError);
  });

  it('uses Sitemap: lines declared in robots.txt', async () => {
    strictEnv();
    const { hits } = await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\nSitemap: https://site.example/custom-map.xml' },
      'https://site.example/custom-map.xml': { type: 'application/xml', body: '<urlset><url><loc>https://site.example/from-map</loc></url></urlset>' },
      'https://site.example/': page('Home', para(60)),
      'https://site.example/from-map': page('Mapped', para(60, 'm')),
    });
    expect(hits).toContain('https://site.example/from-map');
  });

  it('honours Crawl-delay with a per-host request gate', async () => {
    strictEnv({ CRAWL_CONCURRENCY: '4' });
    const t0 = Date.now();
    await run({
      'https://site.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 0.12' },
      'https://site.example/': page('Home', `${para(60)}<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`),
      'https://site.example/a': page('A', para(60, 'a')),
      'https://site.example/b': page('B', para(60, 'b')),
      'https://site.example/c': page('C', para(60, 'c')),
    });
    // 4 pages with 120 ms spacing, even with concurrency 4 → at least ~3 gaps.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(330);
  });
});

describe('duplicates, failures and limits', () => {
  it('indexes a canonical page once when two URLs point at it', async () => {
    strictEnv();
    const canon = '<link rel="canonical" href="https://site.example/post">';
    const { results, summary } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', `${para(60)}<a href="/post">p</a><a href="/post?utm_source=x&amp;ref=y">p2</a><a href="/post/amp">p3</a>`),
      'https://site.example/post': page('Post', para(60, 'p'), canon),
      'https://site.example/post/amp': page('Post', para(60, 'p'), canon),
    });
    const dupes = results.filter((r) => r.ok && r.duplicateOf);
    expect(dupes).toHaveLength(1);
    expect(summary.duplicatePages).toBe(1);
  });

  it('reports failed pages with reasons and does not retry a 404', async () => {
    strictEnv();
    const { summary, results, hits } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', `${para(60)}<a href="/gone">g</a><a href="/locked">l</a><a href="/json">j</a>`),
      'https://site.example/locked': { status: 403, body: 'no' },
      'https://site.example/json': { type: 'application/json', body: '{}' },
    });
    expect(summary.failed).toBe(3);
    expect(summary.errors.map((e) => e.reason).join('|')).toMatch(/404.*|HTTP 404/);
    expect(summary.errors.some((e) => /403/.test(e.reason))).toBe(true);
    expect(summary.errors.some((e) => /not an HTML page|content type/i.test(e.reason))).toBe(true);
    expect(hits.filter((h) => h.endsWith('/gone'))).toHaveLength(1); // no retry on 4xx
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });

  it('stops at the page budget and says so', async () => {
    strictEnv();
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">${i}</a>`).join('');
    const map: Record<string, Reply | string> = { 'https://site.example/robots.txt': { status: 404 }, 'https://site.example/': page('Home', para(60) + links) };
    for (let i = 0; i < 10; i++) map[`https://site.example/p${i}`] = page(`P${i}`, para(60, `p${i}`));
    const { summary } = await run(map, target({ maxPages: 4 }));
    expect(summary.visited).toBe(4);
    expect(summary.budgetExhausted).toBe('pages');
  });

  it('stops when the download-size budget is spent', async () => {
    strictEnv({ CRAWL_MAX_JOB_BYTES: '3000', CRAWL_CONCURRENCY: '1' });
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">${i}</a>`).join('');
    const map: Record<string, Reply | string> = { 'https://site.example/robots.txt': { status: 404 }, 'https://site.example/': page('Home', para(80) + links) };
    for (let i = 0; i < 8; i++) map[`https://site.example/p${i}`] = page(`P${i}`, para(80, `p${i}`));
    const { summary } = await run(map);
    expect(summary.budgetExhausted).toBe('bytes');
    expect(summary.visited).toBeLessThan(9);
  });

  it('respects depth', async () => {
    strictEnv();
    const { hits } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', `${para(60)}<a href="/l1">1</a>`),
      'https://site.example/l1': page('L1', `${para(60, 'a')}<a href="/l2">2</a>`),
      'https://site.example/l2': page('L2', para(60, 'b')),
    }, target({ maxDepth: 1 }));
    expect(hits).toContain('https://site.example/l1');
    expect(hits).not.toContain('https://site.example/l2');
  });

  it('flags client-rendered pages instead of silently indexing nothing', async () => {
    strictEnv();
    const { results, summary } = await run({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': '<!doctype html><html><head><title>App</title><script src="/a.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>',
    });
    expect(summary.jsLimited).toBe(1);
    const first = results[0]!;
    expect(first.ok && first.page.jsRequired).toBe(true);
  });

  it('honours cancellation', async () => {
    strictEnv({ CRAWL_CONCURRENCY: '1' });
    const w = web({
      'https://site.example/robots.txt': { status: 404 },
      'https://site.example/': page('Home', `${para(60)}<a href="/a">a</a><a href="/b">b</a>`),
      'https://site.example/a': page('A', para(60, 'a')),
      'https://site.example/b': page('B', para(60, 'b')),
    });
    let n = 0;
    const summary = await crawl(target(), { onPage: () => void n++, shouldStop: () => n >= 1 }, w.testing);
    expect(summary.visited).toBeLessThanOrEqual(2);
    expect(w.hits).not.toContain('https://site.example/b');
  });
});

describe('policy is enforced at crawl time too', () => {
  it('a host added to the denylist after registration is refused', async () => {
    strictEnv({ CRAWL_DENIED_HOSTS: 'site.example' });
    await expect(run({ 'https://site.example/': page('Home', para(60)) })).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it('a private DNS answer stops the crawl before any request', async () => {
    strictEnv();
    const hits: string[] = [];
    const transport = async (u: URL) => {
      hits.push(u.host);
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page('x', para(60))) };
    };
    const resolver = async () => [{ address: '10.0.0.8', family: 4 as const }];
    await expect(crawl(target(), {}, { transport, resolver })).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(hits).toEqual([]);
  });
});

describe('source registration validation', () => {
  const pub = async () => [{ address: '93.184.216.34', family: 4 as const }];

  it('accepts any public https website and canonicalises it', async () => {
    strictEnv();
    const v = await validateSourceUrl('  HTTPS://Docs.ACME.example:443/guide/?utm_source=x#top ', pub);
    expect(v.url).toBe('https://docs.acme.example/guide');
    expect(v.scopeHost).toBe('docs.acme.example');
    expect((await validateSourceUrl('https://acme.example', pub)).url).toBe('https://acme.example/');
  });

  it.each([
    ['', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['acme.example', 'invalid_url'],
    ['http://acme.example/', 'bad_scheme'],
    ['ftp://acme.example/', 'bad_scheme'],
    ['https://u:p@acme.example/', 'credentials'],
    ['https://localhost/', 'blocked_host'],
    ['https://127.0.0.1/', 'blocked_address'],
    ['https://10.1.1.1/', 'blocked_address'],
    ['https://169.254.169.254/', 'blocked_address'],
    ['https://[::1]/', 'blocked_address'],
  ])('rejects %s (%s)', async (input, reason) => {
    strictEnv();
    const err = await validateSourceUrl(input, pub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUrlError);
    expect((err as SourceUrlError).reason).toBe(reason);
  });

  it('rejects a hostname that resolves to a private address, naming the cause', async () => {
    strictEnv();
    const priv = async () => [{ address: '192.168.4.4', family: 4 as const }];
    const err = (await validateSourceUrl('https://looks-public.example/', priv).catch((e: unknown) => e)) as SourceUrlError;
    expect(err.reason).toBe('blocked_address');
    expect(err.message).toMatch(/resolves to a private/);
    expect(err.host).toBe('looks-public.example');
  });

  it('rejects an unresolvable hostname', async () => {
    strictEnv();
    const fail = async () => {
      throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    };
    expect(((await validateSourceUrl('https://nope.example/', fail).catch((e: unknown) => e)) as SourceUrlError).reason).toBe('dns_failure');
  });

  it('honours the denylist and an optional deployment restriction', async () => {
    strictEnv({ CRAWL_DENIED_HOSTS: 'blocked.example' });
    expect(((await validateSourceUrl('https://www.blocked.example/', pub).catch((e: unknown) => e)) as SourceUrlError).reason).toBe('denied_host');
    strictEnv({ CRAWL_RESTRICT_HOSTS: 'only.example' });
    expect(((await validateSourceUrl('https://other.example/', pub).catch((e: unknown) => e)) as SourceUrlError).reason).toBe('not_in_restriction');
    await expect(validateSourceUrl('https://only.example/', pub)).resolves.toBeTruthy();
  });

  it('is unrestricted by default — no fixed domain list', async () => {
    strictEnv();
    for (const host of ['goldensierra.com', 'acme.example', 'some-random-site.org']) {
      await expect(validateSourceUrl(`https://${host}/`, pub)).resolves.toBeTruthy();
    }
  });
});
