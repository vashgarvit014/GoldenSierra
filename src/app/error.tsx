'use client';

import { useEffect } from 'react';
import { Alert, Button } from '@/components/ui';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Logged client-side only; the server already recorded the real cause.
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-md space-y-4">
        <Alert tone="danger" title="Something went wrong">
          The page could not be loaded. You can try again, or reach Golden Sierra directly at (916)
          746-7722.
        </Alert>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
