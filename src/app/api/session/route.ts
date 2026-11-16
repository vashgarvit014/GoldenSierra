import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MessageRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { clientIpFrom, enforceRateLimit, hashIdentifier } from '@/lib/rate-limit';
import { createSession, loadSession } from '@/lib/session';
import { isFactualLookup, lookupTurn } from '@/lib/counselor/lookup';
import { runTurn } from '@/lib/counselor/engine';
import type { CounselorContext, SessionMode } from '@/types/counselor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Counselor-mode conversation endpoint.
 *
 * POST without `sessionToken` starts a session; with one it runs a turn.
 *
 * Non-streaming on purpose: a turn is one short paragraph plus the structured
 * state the sidebar renders, and those must land together. Streaming the text
 * while the known-facts panel and narrowing count lag behind would look broken.
 */

const StartSchema = z.object({
  mode: z.enum(['self', 'helper']).default('self'),
});

const TurnSchema = z.object({
  sessionToken: z.string().min(16).max(256),
  message: z.string().min(1).max(env.MAX_MESSAGE_CHARS),
  forceResults: z.boolean().optional(),
});

/** Conversation state lives with the session, never in the vector store. */
type StoredState = {
  counselor?: CounselorContext;
  askedQuestions?: string[];
};

function emptyContext(mode: SessionMode): CounselorContext {
  // A helper is, by definition, supporting someone toward work — recording it
  // here saves asking a question whose answer we already have.
  return {
    mode,
    population: [],
    barriers: [],
    ...(mode === 'helper' ? { audience: 'job_seeker' as const } : {}),
  };
}

export const POST = withErrorHandling(async (request: Request) => {
  await enforceRateLimit(`counselor:${await hashIdentifier(clientIpFrom(request))}`);

  const json = (await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  })) as Record<string, unknown>;

  // ── Start a session ──
  if (!json.sessionToken) {
    const { mode } = StartSchema.parse(json);
    const { session, token } = await createSession(request);
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { profile: { counselor: emptyContext(mode), askedQuestions: [] } as never },
    });
    return NextResponse.json({ sessionId: session.id, sessionToken: token, mode });
  }

  // ── Run one turn ──
  const body = TurnSchema.parse(json);
  const message = body.message
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .trim();
  if (!message) throw badRequest('Please enter a message');

  const { session, history } = await loadSession(body.sessionToken);
  const stored = (session.profile ?? {}) as StoredState;
  const context = stored.counselor ?? emptyContext('self');

  await prisma.chatMessage.create({
    data: { sessionId: session.id, role: MessageRole.USER, content: message },
  });

  const started = Date.now();
  const turnInput = {
    message,
    context,
    history: history.map((h) => ({ role: h.role, content: h.content })),
    askedQuestions: stored.askedQuestions ?? [],
    forceResults: body.forceResults,
  };
  // A direct factual question is answered from the indexed documents; personal
  // workforce questions continue through the adaptive counselor flow.
  const { turn, askedQuestions } =
    !body.forceResults && isFactualLookup(message) ? await lookupTurn(turnInput) : await runTurn(turnInput);

  const saved = await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      role: MessageRole.ASSISTANT,
      content: turn.message,
      payload: turn as never,
      latencyMs: Date.now() - started,
    },
  });

  await prisma.chatSession.update({
    where: { id: session.id },
    data: {
      profile: { counselor: turn.context, askedQuestions } as never,
      lastActiveAt: new Date(),
    },
  });

  return NextResponse.json({ messageId: saved.id, turn });
});

/** Replays a conversation for whoever holds its token. */
export const GET = withErrorHandling(async (request: Request) => {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) throw badRequest('A session token is required');

  const { session, history } = await loadSession(token, 60);
  const stored = (session.profile ?? {}) as StoredState;

  return NextResponse.json({
    sessionId: session.id,
    mode: stored.counselor?.mode ?? 'self',
    context: stored.counselor ?? emptyContext('self'),
    messages: history,
  });
});
