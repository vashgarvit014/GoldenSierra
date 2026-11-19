import robotsParser, { type Robot } from 'robots-parser';
import pLimit from 'p-limit';
import { env } from '../env';
import { logger } from '../logger';
import { canonicalHost, NetworkPolicyError, assertHostPermitted } from '../net/policy';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from '../net/safe-fetch';
import { fetchPage, HttpStatusError, type ExtractedPage } from './extract';

/**
 * Breadth-first crawler. Each registered source has its own approved scope:
 * the host it was registered on (a leading "www." is ignored). The crawler
 * never follows a link to another domain, never attempts a login, never
 * retries past an auth challenge, and honours robots.txt (including
 * Crawl-delay). Every byte it fetches goes through `safeFetch`, so the same
 * network-safety rules apply to pages, sitemaps, robots.txt and PDFs.
 */

export type CrawlTarget = {
  rootUrl: string;
  maxDepth: number;
  maxPages: number;
  respectRobots: boolean;
  includePatterns: string[];
  excludePatterns: string[];
};

export type CrawlPageResult =
  | { ok: true; page: ExtractedPage; depth: number; duplicateOf?: string }
  | { ok: false; url: string; depth: number; reason: string; status?: number };

export type CrawlEvents = {
  onPage?: (result: CrawlPageResult) => Promise<void> | void;
  onDiscovered?: (count: number) => void;
  /** Return true to abort the crawl (used for admin cancellation). */
  shouldStop?: () => boolean | Promise<boolean>;
};

export type BudgetReason = 'pages' | 'bytes' | 'time';

export type CrawlSummary = {
  visited: number;
  succeeded: number;
  failed: number;
  pdfLinks: string[];
  skippedByRobots: number;
  skippedByPattern: number;
  skippedOffScope: number;
  duplicatePages: number;
  /** Pages that returned almost no text because they need JavaScript to render. */
  jsLimited: number;
  bytesFetched: number;
  sitemapUrls: number;
  /** Set when the crawl stopped because a budget ran out, not because it ran out of pages. */
  budgetExhausted: BudgetReason | null;
  /** The whole site is excluded by robots.txt. */
  robotsBlocked: boolean;
  /** Every page so far was refused (401/403/429): the site blocks automated access, so the crawl stopped early. */
  accessBlocked?: boolean;
  errors: { url: string; reason: string }[];
};

/** Test seam: inject a resolver/transport to crawl a virtual website with no sockets. */
export type CrawlTesting = Pick<SafeFetchOptions, 'resolver' | 'transport'>;

/** A source's approved scope: its own host, ignoring a leading "www.". */
export function scopeHostOf(url: string): string {
  return canonicalHost(new URL(url).hostname).replace(/^www\./, '');
}

export function urlInScope(url: string | URL, scopeHost: string): boolean {
  try {
    const host = canonicalHost((url instanceof URL ? url : new URL(url)).hostname).replace(/^www\./, '');
    return host === scopeHost;
  } catch {
    return false;
  }
}

/** Normalizes a URL for dedupe: drops the hash, sorts tracking params away,
 *  and strips a trailing slash so "/about" and "/about/" are one page. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source)/i;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** File types that are never useful to index as HTML. */
const SKIP_EXTENSIONS =
  /\.(jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|tar|mp4|mp3|wav|avi|mov|doc|docx|xls|xlsx|ppt|pptx|woff2?|ttf|eot)(\?|$)/i;

/** WordPress and plugin endpoints that carry no user-facing content. */
const SKIP_PATHS =
  /\/(wp-admin|wp-login|wp-json|wp-content\/(uploads\/\d{4}\/\d{2}\/[^.]+\.(?!pdf))|feed|xmlrpc\.php|\?s=|author\/|tag\/|page\/\d+)/i;

function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(url);
    } catch {
      // A malformed admin-supplied pattern must not kill the crawl.
      logger.warn('Ignoring invalid crawl pattern', { pattern });
      return false;
    }
  });
}

export function shouldCrawl(
  url: string,
  target: CrawlTarget,
  scopeHost = scopeHostOf(target.rootUrl),
): { ok: boolean; reason?: string } {
  if (!/^https?:/i.test(url)) return { ok: false, reason: 'non-http scheme' };
  if (!urlInScope(url, scopeHost)) return { ok: false, reason: 'outside source scope' };
  if (SKIP_EXTENSIONS.test(url)) return { ok: false, reason: 'asset file type' };
  if (SKIP_PATHS.test(url)) return { ok: false, reason: 'system path' };
  if (target.excludePatterns.length && matchesAny(url, target.excludePatterns)) {
    return { ok: false, reason: 'matched exclude pattern' };
  }
  if (target.includePatterns.length && !matchesAny(url, target.includePatterns)) {
    return { ok: false, reason: 'did not match include pattern' };
  }
  return { ok: true };
}

export class RobotsUnavailableError extends Error {
  constructor(readonly status: number | null, detail: string) {
    super(
      `robots.txt could not be read (${detail}). To stay compliant the crawler does not fetch a site whose robots.txt it cannot confirm.`,
    );
    this.name = 'RobotsUnavailableError';
  }
}

type RobotsInfo = { robot: Robot | null; sitemaps: string[]; crawlDelayMs: number; robotsUrl?: string };

/**
 * robots-parser answers "disallowed" for any URL whose host differs from the
 * robots.txt it was built from, so apex/www variants of one site were wrongly
 * skipped. A source's apex and www hosts are one site: check the URL against
 * the robots rules as if it were on the host the file came from.
 */
export function robotsDisallows(info: RobotsInfo, url: string): boolean {
  if (!info.robot || !info.robotsUrl) return false;
  try {
    const u = new URL(url);
    const base = new URL(info.robotsUrl);
    u.protocol = base.protocol;
    u.host = base.host;
    return info.robot.isDisallowed(u.toString(), env.CRAWL_USER_AGENT) === true;
  } catch {
    return false;
  }
}

const MAX_ROBOTS_BYTES = 512 * 1024;

/**
 * RFC 9309: a missing robots.txt (4xx) means "everything allowed"; a server
 * error or an unreachable host means the rules are *unknown*, which must be
 * treated as "do not crawl" rather than "crawl freely".
 */
async function loadRobots(rootUrl: string, scopeHost: string, testing: CrawlTesting = {}): Promise<RobotsInfo> {
  const robotsUrl = new URL('/robots.txt', rootUrl).toString();
  let res;
  try {
    res = await safeFetch(robotsUrl, {
      timeoutMs: 10_000,
      maxBytes: MAX_ROBOTS_BYTES,
      allowedContentTypes: [/^text\//, /^application\/octet-stream/, /^$/],
      inScope: (u) => urlInScope(u, scopeHost),
      ...testing,
    });
  } catch (err) {
    if (err instanceof NetworkPolicyError) throw err;
    if (err instanceof SafeFetchError && err.code === 'bad_content_type') {
      return { robot: null, sitemaps: [], crawlDelayMs: 0 }; // not a robots file: treat as absent
    }
    throw new RobotsUnavailableError(null, err instanceof Error ? err.message : String(err));
  }
  if (res.status >= 500) throw new RobotsUnavailableError(res.status, `HTTP ${res.status}`);
  if (res.status >= 400) return { robot: null, sitemaps: [], crawlDelayMs: 0 };

  const robot = robotsParser(robotsUrl, res.text());
  const delay = robot.getCrawlDelay(env.CRAWL_USER_AGENT);
  return {
    robot,
    robotsUrl,
    sitemaps: robot.getSitemaps().slice(0, 10),
    crawlDelayMs: delay ? Math.min(10_000, Math.round(delay * 1000)) : 0,
  };
}

/**
 * Reads the site's XML sitemap(s) when available. Starting from a sitemap is
 * both faster and politer than discovering every URL by following links.
 * Only URLs inside the source's own scope are kept.
 */
export async function discoverFromSitemap(
  rootUrl: string,
  limit = 1000,
  scopeHost = scopeHostOf(rootUrl),
  extraSitemaps: string[] = [],
  testing: CrawlTesting = {},
): Promise<string[]> {
  const found = new Set<string>();
  const queue = [
    ...extraSitemaps,
    new URL('/sitemap_index.xml', rootUrl).toString(),
    new URL('/sitemap.xml', rootUrl).toString(),
  ];
  const seen = new Set<string>();

  while (queue.length && found.size < limit) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl) || seen.size >= 40) continue;
    seen.add(sitemapUrl);
    if (!urlInScope(sitemapUrl, scopeHost)) continue;

    try {
      const response = await safeFetch(sitemapUrl, {
        timeoutMs: 20_000,
        maxBytes: env.CRAWL_MAX_SITEMAP_BYTES,
        allowedContentTypes: [/xml/, /^text\//, /^application\/octet-stream/],
        inScope: (u) => urlInScope(u, scopeHost),
        ...testing,
      });
      if (response.status >= 400) continue;
      const xml = response.text();

      const isIndex = /<sitemapindex/i.test(xml);
      for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        if (found.size >= limit) break;
        const loc = match[1]!.trim();
        if (!urlInScope(loc, scopeHost)) continue;
        if (isIndex) queue.push(loc);
        else {
          const normalized = normalizeUrl(loc);
          if (normalized) found.add(normalized);
        }
      }
    } catch {
      // A missing, oversized or malformed sitemap just means we fall back to link discovery.
    }
  }

  return [...found];
}

/** Spaces requests to one host, even across concurrent workers. */
function createHostGate(minIntervalMs: number) {
  let nextAt = 0;
  return async () => {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextAt);
    nextAt = slot + minIntervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  };
}


export async function crawl(target: CrawlTarget, events: CrawlEvents = {}, testing: CrawlTesting = {}): Promise<CrawlSummary> {
  const log = logger.child({ crawler: target.rootUrl });
  const scopeHost = scopeHostOf(target.rootUrl);
  const startedAt = Date.now();
  const deadlineMs = env.CRAWL_MAX_JOB_MINUTES * 60_000;

  // The denylist can change after a source was registered; honour it at crawl time too.
  await assertHostPermitted(new URL(target.rootUrl).hostname);
  if (env.CRAWL_ALLOWED_HOSTS.length) {
    log.warn('CRAWL_ALLOWED_HOSTS is deprecated and ignored: any public https site may be crawled. Use CRAWL_RESTRICT_HOSTS to restrict.');
  }
  if (env.FIRECRAWL_API_KEY) {
    log.warn('FIRECRAWL_API_KEY is set but the third-party extraction path is disabled: it cannot enforce this crawler\'s network restrictions.');
  }

  const robotsInfo: RobotsInfo = target.respectRobots
    ? await loadRobots(target.rootUrl, scopeHost, testing)
    : { robot: null, sitemaps: [], crawlDelayMs: 0 };

  const summary: CrawlSummary = {
    visited: 0,
    succeeded: 0,
    failed: 0,
    pdfLinks: [],
    skippedByRobots: 0,
    skippedByPattern: 0,
    skippedOffScope: 0,
    duplicatePages: 0,
    jsLimited: 0,
    bytesFetched: 0,
    sitemapUrls: 0,
    budgetExhausted: null,
    robotsBlocked: false,
    errors: [],
  };

  const rootNormalized = normalizeUrl(target.rootUrl);
  if (!rootNormalized) throw new Error(`Invalid root URL: ${target.rootUrl}`);

  if (robotsDisallows(robotsInfo, rootNormalized)) {
    summary.robotsBlocked = true;
    summary.skippedByRobots = 1;
    log.info('robots.txt disallows the root URL; nothing will be fetched');
    return summary;
  }

  const seen = new Set<string>();
  const seenCanonical = new Map<string, string>();
  const pdfLinks = new Set<string>();
  const limit = pLimit(Math.max(1, env.CRAWL_CONCURRENCY));
  const gate = createHostGate(Math.max(env.CRAWL_DELAY_MS, robotsInfo.crawlDelayMs));
  const pageCap = Math.min(target.maxPages, env.CRAWL_MAX_PAGES);

  const budgetLeft = (): BudgetReason | null => {
    if (summary.bytesFetched >= env.CRAWL_MAX_JOB_BYTES) return 'bytes';
    if (Date.now() - startedAt >= deadlineMs) return 'time';
    return null;
  };

  // Seed from the sitemap when one exists, then let link discovery fill gaps.
  let frontier: { url: string; depth: number }[] = [{ url: rootNormalized, depth: 0 }];
  const sitemapUrls = await discoverFromSitemap(target.rootUrl, pageCap * 2, scopeHost, robotsInfo.sitemaps, testing);
  summary.sitemapUrls = sitemapUrls.length;
  if (sitemapUrls.length) {
    // Sitemap URLs are subject to exactly the same scope/include/exclude rules
    // as discovered links; a sitemap cannot widen a source's scope.
    const allowed: string[] = [];
    for (const url of sitemapUrls) {
      if (url === rootNormalized || seen.has(url)) continue;
      const verdict = shouldCrawl(url, target, scopeHost);
      if (!verdict.ok) {
        if (verdict.reason?.includes('pattern')) summary.skippedByPattern++;
        continue;
      }
      seen.add(url);
      allowed.push(url);
    }
    log.info('Seeded crawl from sitemap', {
      found: sitemapUrls.length,
      accepted: allowed.length,
      excluded: sitemapUrls.length - allowed.length,
    });
    frontier.push(...allowed.map((url) => ({ url, depth: 1 })));
  }

  seen.add(rootNormalized);
  events.onDiscovered?.(frontier.length);

  // A site behind bot protection refuses every request. Stop after a handful of refusals with no
  // success instead of spending the whole page budget on 403s — and say why.
  const BLOCKED_AFTER = 8;
  let refused = 0;
  const blocked = () => summary.succeeded === 0 && refused >= BLOCKED_AFTER;

  for (let depth = 0; depth <= target.maxDepth && frontier.length > 0; depth++) {
    if (blocked()) break;
    if (summary.visited >= pageCap) {
      summary.budgetExhausted ??= frontier.length ? 'pages' : null;
      break;
    }
    if (await events.shouldStop?.()) {
      log.info('Crawl stopped by request');
      break;
    }
    const spent = budgetLeft();
    if (spent) {
      summary.budgetExhausted = spent;
      break;
    }

    const batch = frontier.slice(0, Math.max(0, pageCap - summary.visited));
    if (batch.length < frontier.length) summary.budgetExhausted ??= 'pages';
    frontier = [];
    const nextLinks = new Set<string>();

    await Promise.all(
      batch.map((item) =>
        limit(async () => {
          if (summary.visited >= pageCap || blocked()) return;
          if (await events.shouldStop?.()) return;
          const spentNow = budgetLeft();
          if (spentNow) {
            summary.budgetExhausted ??= spentNow;
            return;
          }

          if (robotsDisallows(robotsInfo, item.url)) {
            summary.skippedByRobots++;
            log.debug('Skipped by robots.txt', { url: item.url });
            return;
          }

          await gate(); // politeness: one request slot per interval, per host
          summary.visited++;

          try {
            const page = await fetchPage(item.url, { inScope: (u) => urlInScope(u, scopeHost), ...testing });
            summary.succeeded++;
            summary.bytesFetched += page.byteLength;

            for (const pdf of page.pdfLinks) {
              if (urlInScope(pdf, scopeHost)) pdfLinks.add(pdf);
              else summary.skippedOffScope++;
            }

            for (const link of page.links) {
              const normalized = normalizeUrl(link);
              if (!normalized || seen.has(normalized)) continue;
              const verdict = shouldCrawl(normalized, target, scopeHost);
              if (!verdict.ok) {
                if (verdict.reason === 'outside source scope') summary.skippedOffScope++;
                if (verdict.reason === 'matched exclude pattern' || verdict.reason === 'did not match include pattern') {
                  summary.skippedByPattern++;
                }
                continue;
              }
              seen.add(normalized);
              nextLinks.add(normalized);
            }

            // Duplicate detection: the same canonical page reached by two URLs
            // (tracking params, http/https, /index) is indexed once.
            const canonical = normalizeUrl(page.canonicalUrl ?? page.url) ?? page.url;
            const finalUrl = normalizeUrl(page.url) ?? page.url;
            let duplicateOf: string | undefined;
            if (urlInScope(canonical, scopeHost)) {
              const prior = seenCanonical.get(canonical);
              if (prior && prior !== finalUrl) duplicateOf = prior;
              else seenCanonical.set(canonical, finalUrl);
            }
            if (duplicateOf) summary.duplicatePages++;
            if (page.jsRequired) summary.jsLimited++;

            await events.onPage?.({ ok: true, page, depth: item.depth, duplicateOf });
          } catch (err) {
            summary.failed++;
            const status = err instanceof HttpStatusError ? err.status : undefined;
            const reason = err instanceof Error ? err.message : String(err);

            // 401/403 mean the page is gated. That is a boundary to respect,
            // not an obstacle to work around.
            if (status === 401 || status === 403 || status === 429) {
              refused++;
              log.info('Skipping access-restricted page', { url: item.url, status });
              if (blocked() && !summary.accessBlocked) {
                summary.accessBlocked = true;
                log.warn('Every page is refused; the site blocks automated access. Stopping the crawl.', { refused });
              }
            }

            summary.errors.push({ url: item.url, reason });
            await events.onPage?.({ ok: false, url: item.url, depth: item.depth, reason, status });
          }
        }),
      ),
    );

    frontier = [...nextLinks].map((url) => ({ url, depth: depth + 1 }));
    events.onDiscovered?.(seen.size);
  }

  summary.pdfLinks = [...pdfLinks];
  log.info('Crawl finished', {
    visited: summary.visited,
    succeeded: summary.succeeded,
    failed: summary.failed,
    pdfs: summary.pdfLinks.length,
    bytes: summary.bytesFetched,
    budgetExhausted: summary.budgetExhausted,
  });

  return summary;
}
