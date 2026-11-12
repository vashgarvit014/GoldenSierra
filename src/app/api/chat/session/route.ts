import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/errors';
import { clientIpFrom, enforceRateLimit, hashIdentifier } from '@/lib/rate-limit';
import { createSession } from '@/lib/session';
import { STARTER_QUESTIONS } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/chat/session — starts a new anonymous conversation. */
export const POST = withErrorHandling(async (request: Request) => {
  await enforceRateLimit(`session:${await hashIdentifier(clientIpFrom(request))}`, 30);

  const { session, token } = await createSession(request);

  return NextResponse.json({
    sessionId: session.id,
    sessionToken: token,
    expiresAt: session.expiresAt.toISOString(),
    welcome:
      "Hi — I'm the Golden Sierra Workforce Navigator. I can help you find job search support, " +
      'training, scholarships, paid internships, and hiring help for employers across Placer, ' +
      'El Dorado, and Alpine counties. What brings you here today?',
    starterQuestions: STARTER_QUESTIONS,
  });
});
