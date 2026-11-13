import { getAdminSession } from '@/lib/auth';
import { LoginForm } from '@/components/admin/LoginForm';

export const dynamic = 'force-dynamic';

/**
 * Gate only. The console renders its own sidebar, topbar and navigation, so
 * this layout adds no chrome of its own — it just decides signed-in or not.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();

  if (!session) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <LoginForm />
      </main>
    );
  }

  return <>{children}</>;
}
