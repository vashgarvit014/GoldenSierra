import Link from 'next/link';
import { getAdminSession } from '@/lib/auth';
import { LoginForm } from '@/components/admin/LoginForm';
import { LogoutButton } from '@/components/admin/LogoutButton';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/sources', label: 'Knowledge sources' },
  { href: '/admin/programs', label: 'Programs' },
  { href: '/admin/testing', label: 'Chatbot testing' },
  { href: '/admin/config', label: 'AI configuration' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();

  // The whole dashboard is gated here, so no child page can be reached
  // without a valid session — the API routes re-check independently.
  if (!session) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <LoginForm />
      </main>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-default bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Workforce Navigator — Admin</p>
            <p className="text-xs text-muted truncate">
              {session.email} · {session.role.toLowerCase()}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-xs text-sierra-700 hover:underline dark:text-sierra-300">
              View chatbot
            </Link>
            <LogoutButton />
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 pb-2" aria-label="Admin sections">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-muted hover:text-[var(--text)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}
