import { normalizeUrl } from './crawler';

/**
 * Identity of a crawl root, for duplicate detection. Two spellings of the same
 * site must collide: scheme, a leading "www.", a trailing slash, tracking
 * parameters and the fragment are all ignored.
 */
export function sourceKey(rootUrl: string | null | undefined): string | null {
  if (!rootUrl) return null;
  const normalized = normalizeUrl(rootUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port ? `:${url.port}` : '';
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${host}${port}${path}${url.search}`;
}

export const CRAWLABLE_TYPES = ['WEBSITE', 'SITEMAP', 'SINGLE_PAGE'] as const;
