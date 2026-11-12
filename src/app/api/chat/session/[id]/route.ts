import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { MessageRole } from '@prisma/client';
import { withErrorHandling } from '@/lib/errors';
import { assertSessionOwnership, closeSession } from '@/lib/session';
import type { AssistantPayload } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The caller proves ownership with the token it was issued, not the id. */
function tokenFrom(request: Request): string | null {
  return (
    request.headers.get('x-session-token') ??
    new URL(request.url).searchParams.get('token')
  );
}

/** GET /api/chat/session/:id — replays a conversation for its owner. */
export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const session = await assertSessionOwnership(id, tokenFrom(request));

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: id, role: { in: [MessageRole.USER, MessageRole.ASSISTANT] } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    return NextResponse.json({
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      profile: session.profile,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
        content: m.content,
        payload: (m.payload as AssistantPayload | null) ?? undefined,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  },
);

/** DELETE /api/chat/session/:id — ends and erases a conversation on request. */
export const DELETE = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    await assertSessionOwnership(id, tokenFrom(request));

    const purge = new URL(request.url).searchParams.get('purge') === 'true';
    if (purge) {
      // Cascades to messages, feedback and retrieval logs.
      await prisma.chatSession.delete({ where: { id } });
      return NextResponse.json({ deleted: true });
    }

    await closeSession(id);
    return NextResponse.json({ closed: true });
  },
);
