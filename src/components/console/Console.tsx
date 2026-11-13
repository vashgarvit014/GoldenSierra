'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Overview } from './pages/Overview';
import { ChatPage } from './pages/ChatPage';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { Crawler } from './pages/Crawler';
import { TestingLab } from './pages/TestingLab';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';

/**
 * The console shell.
 *
 * Markup and class names are ported from the supplied prototype so the design
 * is preserved exactly; the difference is that every panel below is backed by
 * a real API call instead of hard-coded sample numbers.
 *
 * It stays a single client-side view (sections toggled by `.page.active`)
 * rather than separate routes, because that is how the prototype behaves —
 * switching tabs is instant and keeps chat state alive in the background.
 */

export type PageId =
  | 'overview'
  | 'chat'
  | 'knowledge'
  | 'crawler'
  | 'testing'
  | 'analytics'
  | 'settings';

const PAGE_NAMES: Record<PageId, string> = {
  overview: 'Overview',
  chat: 'AI Workforce Chat',
  knowledge: 'Knowledge Base',
  crawler: 'Website Crawler',
  testing: 'RAG Testing Lab',
  analytics: 'Analytics',
  settings: 'Settings',
};

const NAV: { group: string; items: { id: PageId; icon: string; label: string }[] }[] = [
  {
    group: 'WORKSPACE',
    items: [
      { id: 'overview', icon: '▦', label: 'Overview' },
      { id: 'chat', icon: '◉', label: 'AI Workforce Chat' },
      { id: 'knowledge', icon: '▤', label: 'Knowledge Base' },
      { id: 'crawler', icon: '◎', label: 'Website Crawler' },
    ],
  },
  {
    group: 'INTELLIGENCE',
    items: [
      { id: 'testing', icon: '⌕', label: 'RAG Testing Lab' },
      { id: 'analytics', icon: '▥', label: 'Analytics' },
      { id: 'settings', icon: '⚙', label: 'Settings' },
    ],
  },
];

// ── Toast + navigation, shared with every page ──────────────────────────
type ConsoleCtx = { notify: (msg: string) => void; go: (page: PageId) => void };
const Ctx = createContext<ConsoleCtx>({ notify: () => {}, go: () => {} });
export const useConsole = () => useContext(Ctx);

export type AdminUser = { email: string; role: string; name?: string | null };

export function Console({ user }: { user: AdminUser }) {
  const [page, setPage] = useState<PageId>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  const go = useCallback((next: PageId) => {
    setPage(next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const initials =
    (user.name ?? user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join('') || 'AD';

  return (
    <Ctx.Provider value={{ notify, go }}>
      <div className="app">
        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} id="sidebar">
          <div className="brand">
            <div className="brand-mark">✦</div>
            <div>
              <div className="brand-name">Golden Sierra</div>
              <div className="brand-sub">WORKFORCE NAVIGATOR</div>
            </div>
          </div>

          {NAV.map((section) => (
            <div key={section.group}>
              <div className="nav-group">{section.group}</div>
              <nav className="nav">
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    className={page === item.id ? 'active' : undefined}
                    onClick={() => go(item.id)}
                    aria-current={page === item.id ? 'page' : undefined}
                  >
                    <span className="ico" aria-hidden="true">
                      {item.icon}
                    </span>{' '}
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          ))}

          <div className="sidebar-bottom">
            <div className="admin-pill">
              <div className="avatar">{initials}</div>
              <div>
                <strong style={{ fontSize: 12 }}>{user.name ?? 'Administrator'}</strong>
                <br />
                <small>{user.role.toLowerCase()}</small>
              </div>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <button
                className="mobile-toggle"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label="Toggle navigation"
              >
                ☰
              </button>
              <div className="breadcrumbs">
                Workspace &nbsp; / &nbsp; <strong id="crumb">{PAGE_NAMES[page]}</strong>
              </div>
            </div>
            <div className="top-right">
              <span className="top-badge">
                <span className="dot" /> LIVE
              </span>
              <a
                href="/"
                className="btn ghost"
                style={{ textDecoration: 'none' }}
                title="Open the public chatbot"
              >
                Public site ↗
              </a>
              <button
                className="btn"
                onClick={async () => {
                  await fetch('/api/admin/auth/logout', { method: 'POST' });
                  window.location.href = '/admin';
                }}
              >
                Sign out
              </button>
            </div>
          </header>

          <main className="content">
            {/* Every page stays mounted so chat history and in-flight work
                survive tab switches, exactly as the prototype behaves. */}
            <Section id="overview" active={page === 'overview'}>
              <Overview />
            </Section>
            <Section id="chat" active={page === 'chat'}>
              <ChatPage />
            </Section>
            <Section id="knowledge" active={page === 'knowledge'}>
              <KnowledgeBase />
            </Section>
            <Section id="crawler" active={page === 'crawler'}>
              <Crawler />
            </Section>
            <Section id="testing" active={page === 'testing'}>
              <TestingLab />
            </Section>
            <Section id="analytics" active={page === 'analytics'}>
              <Analytics />
            </Section>
            <Section id="settings" active={page === 'settings'}>
              <Settings />
            </Section>
          </main>
        </div>
      </div>

      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
        {toast}
      </div>
    </Ctx.Provider>
  );
}

function Section({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`page${active ? ' active' : ''}`} id={id}>
      {children}
    </section>
  );
}

// ── Small helpers every page uses ───────────────────────────────────────

/** Fetches JSON once on mount, with loading/error state and a manual refresh. */
export function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      const body = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { data, error, loading, reload: load };
}

export function Head({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  icon,
  value,
  note,
  loading,
}: {
  label: string;
  icon: string;
  value: string | number;
  note: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        {label}
        <div className="stat-icon" aria-hidden="true">
          {icon}
        </div>
      </div>
      <div className={`stat-number${loading ? ' skeleton' : ''}`}>{loading ? '000' : value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}
