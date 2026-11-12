import { describe, expect, it } from 'vitest';
import { isHostAllowed, normalizeUrl, shouldCrawl, type CrawlTarget } from '@/lib/ingest/crawler';

/**
 * Crawl authorization is a boundary, not an optimisation: these rules are what
 * keep the crawler on hosts the operator actually approved.
 */

const target = (overrides: Partial<CrawlTarget> = {}): CrawlTarget => ({
  rootUrl: 'https://goldensierra.com/',
  maxDepth: 3,
  maxPages: 100,
  respectRobots: true,
  includePatterns: [],
  excludePatterns: [],
  ...overrides,
});

describe('isHostAllowed', () => {
  it('allows a configured host and its subdomains', () => {
    expect(isHostAllowed('https://goldensierra.com/page')).toBe(true);
    expect(isHostAllowed('https://www.goldensierra.com/page')).toBe(true);
  });

  it('refuses any other host', () => {
    expect(isHostAllowed('https://example.com/page')).toBe(false);
    expect(isHostAllowed('https://evil.com/goldensierra.com')).toBe(false);
  });

  it('refuses a lookalike domain that merely ends with the allowed string', () => {
    // "notgoldensierra.com" must not pass a naive endsWith check.
    expect(isHostAllowed('https://notgoldensierra.com/page')).toBe(false);
  });

  it('refuses malformed input', () => {
    expect(isHostAllowed('not a url')).toBe(false);
  });
});

describe('shouldCrawl', () => {
  it('accepts an ordinary page on an allowed host', () => {
    expect(shouldCrawl('https://goldensierra.com/help-for-job-seekers', target()).ok).toBe(true);
  });

  it('refuses an unauthorized host', () => {
    const result = shouldCrawl('https://example.com/page', target());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not authorized/);
  });

  it('refuses non-http schemes', () => {
    expect(shouldCrawl('ftp://goldensierra.com/file', target()).ok).toBe(false);
    expect(shouldCrawl('javascript:alert(1)', target()).ok).toBe(false);
  });

  it('skips binary assets', () => {
    for (const url of [
      'https://goldensierra.com/logo.png',
      'https://goldensierra.com/style.css',
      'https://goldensierra.com/app.js',
    ]) {
      expect(shouldCrawl(url, target()).ok).toBe(false);
    }
  });

  it('skips WordPress system paths', () => {
    expect(shouldCrawl('https://goldensierra.com/wp-admin/index.php', target()).ok).toBe(false);
    expect(shouldCrawl('https://goldensierra.com/wp-json/wp/v2/pages', target()).ok).toBe(false);
  });

  it('honours exclude patterns', () => {
    const result = shouldCrawl(
      'https://goldensierra.com/es/eleva',
      target({ excludePatterns: ['/(es|ru|fa|uk)(/|$)'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exclude/);
  });

  it('excludes a bare language root, not only sub-paths', () => {
    const t = target({ excludePatterns: ['/(es|ru|fa|uk)(/|$)'] });
    expect(shouldCrawl('https://goldensierra.com/fa', t).ok).toBe(false);
    expect(shouldCrawl('https://goldensierra.com/es', t).ok).toBe(false);
  });

  it('restricts to include patterns when any are set', () => {
    const t = target({ includePatterns: ['/help-for-job-seekers'] });
    expect(shouldCrawl('https://goldensierra.com/help-for-job-seekers/jobs', t).ok).toBe(true);
    expect(shouldCrawl('https://goldensierra.com/help-for-employers', t).ok).toBe(false);
  });

  it('ignores a malformed pattern instead of aborting the crawl', () => {
    const t = target({ excludePatterns: ['[invalid('] });
    expect(shouldCrawl('https://goldensierra.com/page', t).ok).toBe(true);
  });
});

describe('normalizeUrl', () => {
  it('drops the fragment', () => {
    expect(normalizeUrl('https://goldensierra.com/page#section')).toBe('https://goldensierra.com/page');
  });

  it('drops a trailing slash so a page is not indexed twice', () => {
    expect(normalizeUrl('https://goldensierra.com/page/')).toBe('https://goldensierra.com/page');
  });

  it('keeps the root slash', () => {
    expect(normalizeUrl('https://goldensierra.com/')).toBe('https://goldensierra.com/');
  });

  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(normalizeUrl('https://goldensierra.com/page?utm_source=x&id=7')).toBe(
      'https://goldensierra.com/page?id=7',
    );
  });

  it('sorts query parameters so order does not create a duplicate', () => {
    expect(normalizeUrl('https://goldensierra.com/p?b=2&a=1')).toBe(
      normalizeUrl('https://goldensierra.com/p?a=1&b=2'),
    );
  });

  it('returns null for malformed input', () => {
    expect(normalizeUrl('not a url')).toBeNull();
  });
});
