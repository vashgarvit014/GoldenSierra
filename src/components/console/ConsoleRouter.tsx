'use client';

import { usePathname } from 'next/navigation';
import { Console, type AdminUser } from './Console';
import { pageForPath } from './routes';

/**
 * Lives in the /admin layout, so it stays mounted while the URL changes
 * between console routes — chat history and in-flight work survive navigation.
 * Routes that are not console modules (e.g. /admin/programs) render their own
 * page instead.
 */
export function ConsoleRouter({ user, children }: { user: AdminUser; children: React.ReactNode }) {
  const page = pageForPath(usePathname());
  if (!page) return <>{children}</>;
  return <Console user={user} page={page} />;
}
