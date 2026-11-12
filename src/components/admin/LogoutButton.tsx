'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export function LogoutButton() {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await fetch('/api/admin/auth/logout', { method: 'POST' });
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
