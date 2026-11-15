import Link from 'next/link';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function HomePage() {
  return (
    <div className="flex h-dvh flex-col">
      <main className="min-h-0 flex-1">
        <ChatPanel />
      </main>
      <Link
        href="/admin"
        className="sr-only focus:not-sr-only focus:absolute focus:bottom-2 focus:right-2 focus:rounded focus:bg-surface focus:px-3 focus:py-1.5 focus:text-xs"
      >
        Admin dashboard
      </Link>
    </div>
  );
}
