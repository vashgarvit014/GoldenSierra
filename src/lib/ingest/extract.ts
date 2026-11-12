import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { env } from '../env';
import { logger } from '../logger';
import { withRetry, withTimeout } from '../errors';

/**
 * Page fetching and content extraction.
 *
 * Three strategies, tried in order of availability:
 *   1. Firecrawl  — when FIRECRAWL_API_KEY is set (handles JS-heavy pages)
 *   2. fetch + Cheerio — the default; the target site is server-rendered
 *   3. Playwright — opt-in, only if the package is installed
 *
 * The output shape is identical regardless of strategy so the rest of the
 * pipeline is unaware of which one ran.
 */

export type ExtractedPage = {
  url: string;
  canonicalUrl: string | null;
  title: string;
  /** Clean plain text with heading markers preserved as "## Heading". */
  text: string;
  html: string | null;
  links: string[];
  pdfLinks: string[];
  description: string | null;
  publishedAt: Date | null;
  httpStatus: number;
  contentType: string;
  strategy: 'firecrawl' | 'cheerio' | 'playwright';
};

/** Elements that are chrome, not content. Removing them stops every page from
 *  embedding the same nav/footer boilerplate, which otherwise dominates search. */
const BOILERPLATE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'header',
  'footer',
  'form',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '.screen-reader-text',
  '.skip-link',
  '.wp-block-navigation',
  '.site-header',
  '.site-footer',
  '.menu',
  '.breadcrumb',
  '.breadcrumbs',
  '.cookie',
  '.social',
  '.sharedaddy',
  '#comments',
  '.comments-area',
];

/** Content roots in priority order; the first that yields real text wins. */
const CONTENT_SELECTORS = [
  'main',
  'article',
  '.entry-content',
  '.page-content',
  '#content',
  '[role="main"]',
  'body',
];

export async function fetchPage(url: string): Promise<ExtractedPage> {
  if (env.FIRECRAWL_API_KEY) {
    try {
      return await fetchWithFirecrawl(url);
    } catch (err) {
      logger.warn('Firecrawl failed; falling back to direct fetch', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return fetchWithCheerio(url);
}

export async function fetchWithCheerio(url: string): Promise<ExtractedPage> {
  const response = await withRetry(
    () =>
      withTimeout(
        fetch(url, {
          headers: {
            'User-Agent': env.CRAWL_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        }),
        env.CRAWL_TIMEOUT_MS,
        `fetch ${url}`,
      ),
    {
      attempts: 3,
      baseMs: 700,
      label: `fetch ${url}`,
      // 4xx responses are permanent; only retry transport and 5xx errors.
      retryOn: (e) => !(e instanceof HttpStatusError && e.status < 500),
    },
  );

  if (!response.ok) throw new HttpStatusError(url, response.status);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/pdf')) {
    throw new Error(`${url} is a PDF; route it through the PDF extractor instead`);
  }

  const html = await response.text();
  const parsed = parseHtml(html, response.url || url);

  return {
    ...parsed,
    url: response.url || url,
    httpStatus: response.status,
    contentType,
    html,
    strategy: 'cheerio',
  };
}

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export function parseHtml(
  html: string,
  baseUrl: string,
): Omit<ExtractedPage, 'url' | 'httpStatus' | 'contentType' | 'html' | 'strategy'> {
  const $ = cheerio.load(html);

  const title =
    text($('meta[property="og:title"]').attr('content')) ||
    text($('h1').first().text()) ||
    text($('title').text()) ||
    baseUrl;

  const description =
    text($('meta[name="description"]').attr('content')) ||
    text($('meta[property="og:description"]').attr('content')) ||
    null;

  const canonicalUrl = absolutize($('link[rel="canonical"]').attr('href'), baseUrl);

  const publishedRaw =
    $('meta[property="article:published_time"]').attr('content') ??
    $('meta[itemprop="datePublished"]').attr('content') ??
    $('time[datetime]').first().attr('datetime');
  const publishedAt = publishedRaw ? safeDate(publishedRaw) : null;

  // Collect links before stripping chrome — navigation is exactly where the
  // crawler finds the rest of the site.
  const links = new Set<string>();
  const pdfLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = absolutize($(el).attr('href'), baseUrl);
    if (!href) return;
    if (/\.pdf(\?|#|$)/i.test(href)) pdfLinks.add(stripHash(href));
    else if (/^https?:/i.test(href)) links.add(stripHash(href));
  });

  $(BOILERPLATE_SELECTORS.join(',')).remove();

  let body = '';
  for (const selector of CONTENT_SELECTORS) {
    const node = $(selector).first();
    if (node.length === 0) continue;
    const candidate = htmlToText($, node);
    if (candidate.length > body.length) body = candidate;
    // `main` on a well-formed page is enough; don't keep widening the net.
    if (body.length > 400 && selector !== 'body') break;
  }

  return {
    canonicalUrl,
    title: cleanTitle(title),
    text: normalizeText(body),
    links: [...links],
    pdfLinks: [...pdfLinks],
    description,
    publishedAt,
  };
}

/**
 * Converts a DOM subtree to plain text while keeping the heading hierarchy as
 * markdown-style markers. Chunking later reads those markers to avoid cutting
 * an eligibility rule away from the heading that scopes it.
 */
function htmlToText($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): string {
  const parts: string[] = [];

  root.find('h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,figcaption').each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const content = text($(el).text());
    if (!content) return;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      parts.push(`\n${'#'.repeat(level)} ${content}\n`);
    } else if (tag === 'li') {
      parts.push(`- ${content}`);
    } else {
      parts.push(content);
    }
  });

  // Pages built entirely from divs yield nothing above; fall back to raw text.
  if (parts.join('').trim().length < 80) return text(root.text());

  return parts.join('\n');
}

export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    // Drop lines that repeat consecutively — a common artefact of card grids.
    .filter((line, i, arr) => line.trim() !== '' || arr[i - 1]?.trim() !== '')
    .join('\n')
    .trim();
}

function cleanTitle(raw: string): string {
  // "Help for Job Seekers - Golden Sierra Job Training Agency" -> drop the suffix.
  return text(raw).replace(/\s*[-–|]\s*Golden Sierra.*$/i, '').trim() || text(raw);
}

function text(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function absolutize(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function safeDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Firecrawl ────────────────────────────────────────────────────────────

async function fetchWithFirecrawl(url: string): Promise<ExtractedPage> {
  const response = await withTimeout(
    fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, formats: ['markdown', 'links'], onlyMainContent: true }),
    }),
    env.CRAWL_TIMEOUT_MS,
    `firecrawl ${url}`,
  );

  if (!response.ok) throw new Error(`Firecrawl returned HTTP ${response.status}`);

  const body = (await response.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      links?: string[];
      metadata?: {
        title?: string;
        description?: string;
        sourceURL?: string;
        statusCode?: number;
        publishedTime?: string;
      };
    };
  };

  const data = body.data;
  if (!body.success || !data?.markdown) throw new Error('Firecrawl returned no content');

  const links = (data.links ?? []).filter((l) => /^https?:/i.test(l));
  const meta = data.metadata ?? {};

  return {
    url: meta.sourceURL ?? url,
    canonicalUrl: meta.sourceURL ?? null,
    title: cleanTitle(meta.title ?? url),
    text: normalizeText(data.markdown),
    html: null,
    links: links.filter((l) => !/\.pdf(\?|#|$)/i.test(l)),
    pdfLinks: links.filter((l) => /\.pdf(\?|#|$)/i.test(l)),
    description: meta.description ?? null,
    publishedAt: meta.publishedTime ? safeDate(meta.publishedTime) : null,
    httpStatus: meta.statusCode ?? 200,
    contentType: 'text/html',
    strategy: 'firecrawl',
  };
}
