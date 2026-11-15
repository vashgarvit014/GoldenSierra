import { ChatPanel } from '@/components/chat/ChatPanel';

export const dynamic = 'force-dynamic';

/** The original direct-answer assistant, kept for comparison and testing. */
export default function DirectChatPage() {
  return (
    <div className="flex h-dvh flex-col">
      <main className="min-h-0 flex-1">
        <ChatPanel />
      </main>
    </div>
  );
}
