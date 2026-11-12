import { AdminRole } from '@prisma/client';
import { requireAdmin } from '@/lib/auth';
import { SourcesManager } from '@/components/admin/SourcesManager';

export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  const session = await requireAdmin(AdminRole.VIEWER);
  // Viewers can see what is configured but cannot start jobs or change sources.
  const canEdit = session.role === AdminRole.EDITOR || session.role === AdminRole.ADMIN;

  return <SourcesManager canEdit={canEdit} />;
}
