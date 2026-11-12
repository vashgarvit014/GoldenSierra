import robotsParser, { type Robot } from 'robots-parser';
import pLimit from 'p-limit';
import { env } from '../env';
import { logger } from '../logger';
import { fetchPage, HttpStatusError, type ExtractedPage } from './extract';

/**
 * Breadth-first crawler for authorized hosts only.
 *
 * Authorization is enforced twice and deliberately: a host must be listed in
 * CRAWL_ALLOWED_HOSTS (deployment-level) *and* reachable from a KnowledgeSource
 * root (operator-level). The crawler never follows a link off-host, never
 * attempts a login, and never retries past an auth challenge.
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
  | { ok: true; page: ExtractedPage; depth: number }
  | { ok: false; url: string; depth: number; reason: string; status?: number };

export type CrawlEvents = {
  onPage?: (result: CrawlPageResult) => Promise<void> | void;
  onDiscovered?: (count: number) => void;
  /** Return true to abort the crawl (used for admin cancellation). */
  shouldStop?: () => boolean | Promise<boolean>;
};

export type CrawlSummary = {
  visited: number;
  succeeded: number;
  failed: number;
  pdfLinks: string[];
  skippedByRobots: number;
  skippedByPattern: number;
  errors: { url: string; reason: string }[];
};

export function isHostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return env.CRAWL_ALLOWED_HOSTS.some((allowed) => {
      const a = allowed.toLowerCase();
      return host === a || host.endsWith(`.${a}`);
    });
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

export function shouldCrawl(url: string, target: CrawlTarget): { ok: boolean; reason?: string } {
  if (!/^https?:/i.test(url)) return { ok: false, reason: 'non-http scheme' };
  if (!isHostAllowed(url)) return { ok: false, reason: 'host not authorized' };
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

async function loadRobots(rootUrl: string): Promise<Robot | null> {
  try {
    const robotsUrl = new URL('/robots.txt', rootUrl).toString();
    const response = await fetch(robotsUrl, {
      headers: { 'User-Agent': env.CRAWL_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return robotsParser(robotsUrl, await response.text());
  } catch {
    logger.warn('Could not read robots.txt; proceeding with conservative defaults', { rootUrl });
    return null;
  }
}

/**
 * Reads the site's XML sitemap(s) when available. Starting from a sitemap is
 * both faster and politer than discovering every URL by following links.
 */
export async function discoverFromSitemap(rootUrl: string, limit = 1000): Promise<string[]> {
  const found = new Set<string>();
  const queue = [new URL('/sitemap_index.xml', rootUrl).toString(), new URL('/sitemap.xml', rootUrl).toString()];
  const seen = new Set<string>();

  while (queue.length && found.size < limit) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);

    try {
      const response = await fetch(sitemapUrl, {
        headers: { 'User-Agent': env.CRAWL_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const xml = await response.text();

      const isIndex = /<sitemapindex/i.test(xml);
      for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const loc = match[1]!.trim();
        if (isIndex) {
          if (seen.size < 40) queue.push(loc);
        } else if (isHostAllowed(loc)) {
          const normalized = normalizeUrl(loc);
          if (normalized) found.add(normalized);
        }
      }
    } catch {
      // A missing or malformed sitemap just means we fall back to link discovery.
    }
  }

  return [...found];
}

export async function crawl(target: CrawlTarget, events: CrawlEvents = {}): Promise<CrawlSummary> {
  const log = logger.child({ crawler: target.rootUrl });

  if (!isHostAllowed(target.rootUrl)) {
    throw new Error(
      `Refusing to crawl ${target.rootUrl}: its host is not in CRAWL_ALLOWED_HOSTS. ` +
        'Add it there first to authorize indexing.',
    );
  }

  const robots = target.respectRobots ? await loadRobots(target.rootUrl) : null;
  const summary: CrawlSummary = {
    visited: 0,
    succeeded: 0,
    failed: 0,
    pdfLinks: [],
    skippedByRobots: 0,
    skippedByPattern: 0,
    errors: [],
  };

  const seen = new Set<string>();
  const pdfLinks = new Set<string>();
  const limit = pLimit(Math.max(1, env.CRAWL_CONCURRENCY));

  const rootNormalized = normalizeUrl(target.rootUrl);
  if (!rootNormalized) throw new Error(`Invalid root URL: ${target.rootUrl}`);

  // Seed from the sitemap when one exists, then let link discovery fill gaps.
  let frontier: { url: string; depth: number }[] = [{ url: rootNormalized, depth: 0 }];
  const sitemapUrls = await discoverFromSitemap(target.rootUrl, target.maxPages * 2);
  if (sitemapUrls.length) {
    // Sitemap URLs are subject to exactly the same include/exclude rules as
    // discovered links. Skipping this check would let a sitemap silently
    // override an operator's exclusions.
    const allowed: string[] = [];
    for (const url of sitemapUrls) {
      if (url === rootNormalized || seen.has(url)) continue;
      const verdict = shouldCrawl(url, target);
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

  for (let depth = 0; depth <= target.maxDepth && frontier.length > 0; depth++) {
    if (summary.visited >= target.maxPages) break;
    if (await events.shouldStop?.()) {
      log.info('Crawl stopped by request');
      break;
    }

    const batch = frontier.slice(0, Math.max(0, target.maxPages - summary.visited));
    frontier = [];
    const nextLinks = new Set<string>();

    await Promise.all(
      batch.map((item) =>
        limit(async () => {
          if (summary.visited >= target.maxPages) return;
          if (await events.shouldStop?.()) return;

          // Politeness delay, applied per request inside the concurrency gate.
          if (env.CRAWL_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, env.CRAWL_DELAY_MS));
          }

          if (robots && robots.isDisallowed(item.url, env.CRAWL_USER_AGENT)) {
            summary.skippedByRobots++;
            log.debug('Skipped by robots.txt', { url: item.url });
            return;
          }

          summary.visited++;

          try {
            const page = await fetchPage(item.url);
            summary.succeeded++;

            for (const pdf of page.pdfLinks) {
              if (isHostAllowed(pdf)) pdfLinks.add(pdf);
            }

            for (const link of page.links) {
              const normalized = normalizeUrl(link);
              if (!normalized || seen.has(normalized)) continue;
              const verdict = shouldCrawl(normalized, target);
              if (!verdict.ok) {
                if (verdict.reason === 'matched exclude pattern' || verdict.reason === 'did not match include pattern') {
                  summary.skippedByPattern++;
                }
                continue;
              }
              seen.add(normalized);
              nextLinks.add(normalized);
            }

            await events.onPage?.({ ok: true, page, depth: item.depth });
          } catch (err) {
            summary.failed++;
            const status = err instanceof HttpStatusError ? err.status : undefined;
            const reason = err instanceof Error ? err.message : String(err);

            // 401/403 mean the page is gated. That is a boundary to respect,
            // not an obstacle to work around.
            if (status === 401 || status === 403) {
              log.info('Skipping access-restricted page', { url: item.url, status });
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
  });

  return summary;
}
