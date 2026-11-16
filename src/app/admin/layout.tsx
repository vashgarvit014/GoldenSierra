import { getAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { LoginForm } from '@/components/admin/LoginForm';
import { ConsoleRouter } from '@/components/console/ConsoleRouter';
import '../console.css';

export const dynamic = 'force-dynamic';

/**
 * Gate and host for the console.
 *
 * Signed out: the sign-in form, and nothing else reaches the browser.
 * Signed in: the console shell for every module route (/admin, /admin/chat,
 * /admin/crawler, …), kept mounted across navigation. Routes that are not
 * console modules (/admin/programs) render their own page, which does its own
 * server-side role check.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();

  if (!session) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted px-6 py-10">
        <LoginForm />
      </main>
    );
  }

  const user = await prisma.adminUser.findUnique({
    where: { id: session.userId },
    select: { email: true, name: true, role: true },
  });

  return (
    <ConsoleRouter
      user={{
        email: user?.email ?? session.email,
        name: user?.name ?? null,
        role: user?.role ?? session.role,
      }}
    >
      {children}
    </ConsoleRouter>
  );
}
