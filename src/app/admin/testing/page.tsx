import { AdminRole } from '@prisma/client';
import { requireAdmin } from '@/lib/auth';
import { TestConsole } from '@/components/admin/TestConsole';

export const dynamic = 'force-dynamic';

export default async function TestingPage() {
  await requireAdmin(AdminRole.VIEWER);
  return <TestConsole />;
}
