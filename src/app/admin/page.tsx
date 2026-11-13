import { AdminRole } from '@prisma/client';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Console } from '@/components/console/Console';
import '../console.css';

export const dynamic = 'force-dynamic';

/**
 * The admin console.
 *
 * Auth is enforced here on the server, so no console markup or data reaches
 * the browser without a valid session. The layout above renders the sign-in
 * form when there is none.
 */
export default async function AdminConsolePage() {
  const session = await requireAdmin(AdminRole.VIEWER);
  const user = await prisma.adminUser.findUnique({
    where: { id: session.userId },
    select: { email: true, name: true, role: true },
  });

  return (
    <Console
      user={{
        email: user?.email ?? session.email,
        name: user?.name ?? null,
        role: user?.role ?? session.role,
      }}
    />
  );
}
