'use client';

import { Head } from '../Console';
import { Navigator } from '@/components/navigator/Navigator';

/**
 * The live assistant inside the console shell: the Golden Sierra Workforce Navigator, running the real
 * pipeline (/api/chat guided flow, strict indexed-document answers, role-based job matching).
 */
export function ChatPage() {
  return (
    <>
      <Head eyebrow="LIVE ASSISTANT" title="AI Workforce Chat" sub="Workforce Navigator — answers and matches come only from indexed sources, with citations." />
      <Navigator />
    </>
  );
}
