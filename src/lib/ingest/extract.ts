import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { env } from '../env';
import { logger } from '../logger';
import { withRetry } from '../errors';
import { NetworkPolicyError } from '../net/policy';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from '../net/safe-fetch';

/**
 * Page fetching and content extraction.
 *
 * One strategy: a restricted fetch (`safeFetch`) plus Cheerio. Pages that only
 * render with JavaScript are *reported* as such rather than silently indexed as
 * empty. Third-party extraction services (Firecrawl) are intentionally not
 * used: they fetch from their own network, so this application cannot enforce
 * its SSRF, scope and robots rules on them.
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
  strategy: 'cheerio';
  /** Decompressed bytes downloaded, for crawl budgets. */
  byteLength: number;
  /** Almost no text, and the markup looks like a client-rendered app shell. */
  jsRequired: boolean;
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
  // Related-content widgets: the same list on every page of a post type.
  '.tribe-events-related-events',
  '[class*="related-events"]',
  '[class*="related-posts"]',
  '[id*="related-events"]',
];

/** Content roots in priority order; the first that yields real text wins. */
/** Elements whose text is emitted as one unit (headings keep their level, list items a bullet). */
const TEXT_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,figcaption';
const TEXT_BLOCK = /^(h[1-6]|p|li|td|th|dt|dd|blockquote|figcaption)$/;
/** Inline elements: their text belongs on one line, never split per child. */
const INLINE = /^(a|span|strong|b|em|i|small|label|time|abbr|cite|code|mark|u|sup|sub|address)$/;

const CONTENT_SELECTORS = [
  'main',
  'article',
  '.entry-content',
  '.page-content',
  '#content',
  '[role="main"]',
  'body',
];

export type FetchPageOptions = { inScope?: (url: URL) => boolean } & Pick<SafeFetchOptions, 'resolver' | 'transport'>;

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<ExtractedPage> {
  return fetchWithCheerio(url, options);
}

export class UnsupportedContentError extends Error {
  constructor(
    readonly url: string,
    readonly contentType: string,
  ) {
    super(`${url} is not an HTML page (${contentType || 'unknown content type'})`);
    this.name = 'UnsupportedContentError';
  }
}

/** Transport failures and 5xx are worth retrying; policy, scope, size and 4xx never are. */
function isTransient(err: unknown): boolean {
  if (err instanceof NetworkPolicyError) return false;
  if (err instanceof HttpStatusError) return err.status >= 500;
  if (err instanceof SafeFetchError) return err.code === 'network' || err.code === 'timeout';
  return false;
}

export async function fetchWithCheerio(url: string, options: FetchPageOptions = {}): Promise<ExtractedPage> {
  const response = await withRetry(
    async () => {
      const res = await safeFetch(url, {
        maxBytes: env.CRAWL_MAX_PAGE_BYTES,
        allowedContentTypes: [/^text\/html/, /^application\/xhtml\+xml/, /^application\/pdf/, /^$/],
        inScope: options.inScope,
        resolver: options.resolver,
        transport: options.transport,
      });
      if (res.status >= 400) throw new HttpStatusError(url, res.status);
      return res;
    },
    { attempts: 3, baseMs: 700, label: `fetch ${url}`, retryOn: isTransient },
  );

  if (response.contentType.includes('application/pdf')) {
    throw new Error(`${url} is a PDF; route it through the PDF extractor instead`);
  }
  if (response.contentType && !/html|xhtml/.test(response.contentType)) {
    throw new UnsupportedContentError(url, response.contentType);
  }

  const html = response.text();
  const finalUrl = response.url || url;
  const parsed = parseHtml(html, finalUrl);

  return {
    ...parsed,
    url: finalUrl,
    httpStatus: response.status,
    contentType: response.contentType,
    html,
    strategy: 'cheerio',
    byteLength: response.body.length,
    jsRequired: looksJsRendered(html, parsed.text),
  };
}

/**
 * A page with almost no extracted text whose markup is an app shell
 * (`<div id="root">`, `<noscript>Enable JavaScript`) needs a browser to render.
 * Reporting that is more honest than indexing an empty page and calling it done.
 */
export function looksJsRendered(html: string, extractedText: string): boolean {
  const words = extractedText.split(/\s+/).filter(Boolean).length;
  if (words >= 40) return false;
  const shell =
    /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["']/i.test(html) ||
    /\bng-app\b|data-reactroot|window\.__NUXT__|__NEXT_DATA__/i.test(html) ||
    /<noscript[^>]*>[^<]*(enable|requires?|turn on)[^<]*javascript/i.test(html);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  return shell || scripts >= 5;
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
): Omit<ExtractedPage, 'url' | 'httpStatus' | 'contentType' | 'html' | 'strategy' | 'byteLength' | 'jsRequired'> {
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
  const emit = (tag: string, content: string) => {
    if (/^h[1-6]$/.test(tag)) parts.push(`\n${'#'.repeat(Number(tag[1]))} ${content}\n`);
    else if (tag === 'li') parts.push(`- ${content}`);
    else parts.push(content);
  };

  // Walk the tree in document order. Text elements (headings, paragraphs, list items, cells) are
  // emitted whole. A layout element (div, section, span…) that contains none of them is emitted
  // as one line — directories and job boards built from plain divs ("<div class=mn-title><a>Business
  // name</a></div>") would otherwise lose every name and description and keep only stray list items.
  const walk = (node: AnyNode) => {
    const el = node as { type?: string; tagName?: string; data?: string; children?: AnyNode[] };
    if (el.type === 'text') {
      const t = text(el.data);
      if (t) parts.push(t);
      return;
    }
    if (el.type !== 'tag' && el.type !== 'root') return;
    const tag = el.tagName?.toLowerCase() ?? '';
    // A list item or cell that wraps paragraphs is walked, so each paragraph stays its own line.
    if (TEXT_BLOCK.test(tag) && $(node).find(TEXT_BLOCK_SELECTOR).length === 0) {
      const content = text($(node).text());
      if (content) emit(tag, content);
      return;
    }
    if (INLINE.test(tag) || $(node).find(TEXT_BLOCK_SELECTOR).length === 0) {
      const content = text($(node).text());
      if (content) parts.push(content);
      return;
    }
    for (const child of el.children ?? []) walk(child);
  };
  // Adjacent blocks often have no whitespace between them in the markup ("…Campground</p><p>Desolation…");
  // a separator keeps their words apart when an element's text is read in one piece.
  root.find('br').replaceWith(' ');
  root.find('p,div,li,td,th,dt,dd,h1,h2,h3,h4,h5,h6,section,article,ul,ol,blockquote,figcaption').append(' ');
  root.each((_, el) => {
    for (const child of (el as { children?: AnyNode[] }).children ?? []) walk(child);
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
