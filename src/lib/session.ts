import { randomBytes } from 'node:crypto';
import { MessageRole, type ChatSession } from '@prisma/client';
import { prisma } from './db';
import { env } from './env';
import { notFound, unauthorized } from './errors';
import { hashIdentifier } from './rate-limit';
import { logger } from './logger';
import type { AssistantPayload, ChatTurn, UserProfile } from '@/types/chat';

/**
 * Anonymous conversation sessions.
 *
 * Ownership is proved by an opaque random token held by the browser. Two
 * properties follow from that, both deliberate:
 *
 *  - A session can only ever be read by whoever holds its token, so one
 *    person's conversation cannot be reached by guessing an id.
 *  - We store no identity. The `profile` holds only workforce facts the user
 *    volunteered; IP and user-agent are kept as salted hashes for abuse
 *    handling and nothing else.
 *
 * Conversation data lives in Postgres, never in the vector store — the index
 * is shared across all users and is the wrong place for anything personal.
 */

export type SessionContext = {
  session: ChatSession;
  profile: UserProfile;
  history: ChatTurn[];
};

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function expiryDate(): Date {
  return new Date(Date.now() + env.CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function createSession(request?: Request): Promise<{ session: ChatSession; token: string }> {
  const token = newSessionToken();

  const [ipHash, userAgentHash] = request
    ? await Promise.all([
        hashIdentifier(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'),
        hashIdentifier(request.headers.get('user-agent') ?? 'unknown'),
      ])
    : [null, null];

  const session = await prisma.chatSession.create({
    data: { sessionToken: token, expiresAt: expiryDate(), ipHash, userAgentHash },
  });

  return { session, token };
}

/**
 * Loads a session by its token. The token is the only accepted credential —
 * a session id alone is never sufficient.
 */
export async function loadSession(token: string, historyLimit = 20): Promise<SessionContext> {
  const session = await prisma.chatSession.findUnique({ where: { sessionToken: token } });
  if (!session) throw notFound('That conversation could not be found. Start a new one to continue.');

  if (session.expiresAt < new Date()) {
    throw unauthorized('This conversation has expired. Please start a new one.');
  }

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: session.id, role: { in: [MessageRole.USER, MessageRole.ASSISTANT] } },
    orderBy: { createdAt: 'asc' },
    take: historyLimit,
  });

  return {
    session,
    profile: (session.profile ?? {}) as UserProfile,
    history: messages.map((message) => ({
      id: message.id,
      role: message.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
      content: message.content,
      payload: (message.payload as AssistantPayload | null) ?? undefined,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

/** Verifies that a session id belongs to the caller's token. */
export async function assertSessionOwnership(sessionId: string, token: string | null): Promise<ChatSession> {
  if (!token) throw unauthorized('A session token is required.');
  const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
  if (!session || session.sessionToken !== token) {
    // Same error for "wrong token" and "no such session", so the endpoint
    // cannot be used to discover which session ids exist.
    throw notFound('That conversation could not be found.');
  }
  return session;
}

export async function appendUserMessage(sessionId: string, content: string) {
  return prisma.chatMessage.create({
    data: { sessionId, role: MessageRole.USER, content },
  });
}

export async function appendAssistantMessage(
  sessionId: string,
  content: string,
  payload: AssistantPayload,
  metrics: { tokensIn?: number; tokensOut?: number; latencyMs?: number } = {},
) {
  return prisma.chatMessage.create({
    data: {
      sessionId,
      role: MessageRole.ASSISTANT,
      content,
      payload: payload as never,
      tokensIn: metrics.tokensIn ?? null,
      tokensOut: metrics.tokensOut ?? null,
      latencyMs: metrics.latencyMs ?? null,
    },
  });
}

export async function updateProfile(sessionId: string, profile: UserProfile): Promise<void> {
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { profile: profile as never, lastActiveAt: new Date() },
  });
}

export async function closeSession(sessionId: string): Promise<void> {
  await prisma.chatSession.update({ where: { id: sessionId }, data: { closedAt: new Date() } });
}

/**
 * Retention sweep. Deletes whole expired sessions (messages and feedback
 * cascade) so conversation text does not accumulate indefinitely.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.chatSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (count > 0) logger.info('Purged expired chat sessions', { count });
  return count;
}
