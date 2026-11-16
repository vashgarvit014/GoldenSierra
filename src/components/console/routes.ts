/** Canonical admin routes — the single source of truth for navigation. */
export type PageId = 'overview' | 'chat' | 'knowledge' | 'crawler' | 'testing' | 'analytics' | 'settings';

export const ROUTES: Record<PageId, string> = {
  overview: '/admin',
  chat: '/admin/chat',
  knowledge: '/admin/knowledge',
  crawler: '/admin/crawler',
  testing: '/admin/testing',
  analytics: '/admin/analytics',
  settings: '/admin/settings',
};

export const PAGE_NAMES: Record<PageId, string> = {
  overview: 'Overview',
  chat: 'AI Workforce Chat',
  knowledge: 'Knowledge Base',
  crawler: 'Website Crawler',
  testing: 'RAG Testing Lab',
  analytics: 'Analytics',
  settings: 'Settings',
};

/** Old URLs that still work; next.config.ts redirects them. */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/admin/sources': ROUTES.crawler,
  '/admin/config': ROUTES.settings,
};

/** Which console page a pathname belongs to, or null (e.g. /admin/programs). */
export function pageForPath(pathname: string | null): PageId | null {
  if (!pathname) return null;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const hit = (Object.entries(ROUTES) as [PageId, string][]).find(([, route]) => route === clean);
  return hit ? hit[0] : null;
}
