import { NextResponse } from 'next/server';
import { z } from 'zod';
import { FeedbackRating } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { clientIpFrom, enforceRateLimit, hashIdentifier } from '@/lib/rate-limit';
import { assertSessionOwnership } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  sessionId: z.string().min(1),
  sessionToken: z.string().min(16),
  messageId: z.string().min(1).optional(),
  rating: z.enum(['HELPFUL', 'NOT_HELPFUL']),
  comment: z.string().max(1000).optional(),
});

/** POST /api/chat/feedback — records a thumbs up/down on an answer. */
export const POST = withErrorHandling(async (request: Request) => {
  await enforceRateLimit(`feedback:${await hashIdentifier(clientIpFrom(request))}`, 30);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = BodySchema.parse(json);

  await assertSessionOwnership(body.sessionId, body.sessionToken);

  // Feedback may only ever be attached to a message in the caller's own session.
  if (body.messageId) {
    const message = await prisma.chatMessage.findUnique({
      where: { id: body.messageId },
      select: { sessionId: true },
    });
    if (!message || message.sessionId !== body.sessionId) {
      throw notFound('That message could not be found in this conversation.');
    }
  }

  const feedback = await prisma.chatFeedback.upsert({
    where: { id: `${body.sessionId}:${body.messageId ?? 'session'}` },
    create: {
      id: `${body.sessionId}:${body.messageId ?? 'session'}`,
      sessionId: body.sessionId,
      messageId: body.messageId ?? null,
      rating: body.rating as FeedbackRating,
      comment: body.comment ?? null,
    },
    update: { rating: body.rating as FeedbackRating, comment: body.comment ?? null },
  });

  return NextResponse.json({ id: feedback.id, recorded: true });
});
