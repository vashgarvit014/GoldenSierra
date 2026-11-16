'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ROUTES } from '@/components/console/routes';

const LINKS = [
  { href: ROUTES.overview, label: 'Console' },
  { href: ROUTES.crawler, label: 'Sources' },
  { href: '/admin/programs', label: 'Programs' },
  { href: ROUTES.testing, label: 'Testing' },
  { href: ROUTES.settings, label: 'AI config' },
];

/**
 * Header and page frame for the admin sub-pages. The console at /admin draws
 * its own sidebar; these pages share this charcoal header instead, so moving
 * between them feels like one product.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-dvh bg-muted">
      <header className="on-ink bg-ink text-ink-foreground">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/admin" className="flex items-center gap-3" aria-label="Golden Sierra admin home">
            <Logo onInk className="h-8" />
            <span className="hidden text-xs font-bold uppercase tracking-widest text-ink-muted sm:inline">
              Admin
            </span>
          </Link>
          <nav aria-label="Admin" className="-mx-1 flex flex-wrap items-center gap-x-1">
            {LINKS.map((link) => {
              const active = link.href === '/admin' ? pathname === '/admin' : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex min-h-11 items-center border-b-2 px-2.5 text-sm font-bold transition-colors',
                    active
                      ? 'border-primary text-primary'
                      : 'border-transparent text-ink-foreground hover:text-primary',
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
            <Link
              href="/"
              className="ml-1 inline-flex min-h-11 items-center px-2.5 text-sm font-semibold text-ink-muted hover:text-ink-foreground"
            >
              Public site ↗
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
