import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { clientIpFrom, enforceRateLimit, hashIdentifier } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  appendAssistantMessage,
  appendUserMessage,
  loadSession,
  updateProfile,
} from '@/lib/session';
import { finalizeAnswer, generateFollowUps, prepareTurn, streamAnswer } from '@/lib/rag/generate';
import type { AssistantPayload } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat
 *
 * Streams an answer as newline-delimited JSON events:
 *   {"type":"meta",  ...}   once, before generation: intent, recommendations, sources
 *   {"type":"token", "value":"..."}  repeatedly, as the model writes
 *   {"type":"done",  ...}   once, with the final payload and message id
 *   {"type":"error", ...}   on failure
 *
 * Metadata is sent first so the UI can render recommendation cards and the
 * source list while the prose is still arriving.
 */

const BodySchema = z.object({
  message: z.string().min(1, 'Please enter a question').max(env.MAX_MESSAGE_CHARS),
  sessionToken: z.string().min(16).max(256),
  stream: z.boolean().optional().default(true),
});

export const POST = withErrorHandling(async (request: Request) => {
  const ip = clientIpFrom(request);
  await enforceRateLimit(`chat:${await hashIdentifier(ip)}`);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = BodySchema.parse(json);

  // Reject control characters and zero-width runs sometimes used to smuggle
  // instructions past a visual review.
  const message = body.message
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .trim();
  if (!message) throw badRequest('Please enter a question');

  const { session, profile, history } = await loadSession(body.sessionToken);

  const started = Date.now();
  await appendUserMessage(session.id, message);

  const prepared = await prepareTurn({ message, history, profile, sessionId: session.id });
  await updateProfile(session.id, prepared.profile);

  const meta = {
    type: 'meta' as const,
    intent: prepared.payloadBase.intent,
    confidence: prepared.payloadBase.confidence,
    recommendations: prepared.payloadBase.recommendations,
    sources: prepared.payloadBase.sources,
    citations: prepared.payloadBase.citations,
    conflicts: prepared.payloadBase.conflicts,
    profile: prepared.profile,
  };

  // ── Non-streaming path (used by the admin console and the eval harness) ──
  if (!body.stream) {
    let raw = '';
    for await (const token of streamAnswer(prepared)) raw += token;

    const finalized = finalizeAnswer(raw, prepared);
    const followUps = await generateFollowUps(message, finalized.answer, prepared.analysis);

    const payload: AssistantPayload = {
      ...prepared.payloadBase,
      citations: finalized.citations,
      followUpSuggestions: followUps,
      grounded: finalized.grounding.grounded && prepared.usedSources.length > 0,
      latencyMs: Date.now() - started,
    };

    const saved = await appendAssistantMessage(session.id, finalized.answer, payload, {
      latencyMs: payload.latencyMs,
    });
    await logRetrieval(session.id, saved.id, message, prepared, payload, started);

    return NextResponse.json({ messageId: saved.id, answer: finalized.answer, payload });
  }

  // ── Streaming path ──
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        send(meta);

        let raw = '';
        for await (const token of streamAnswer(prepared)) {
          raw += token;
          send({ type: 'token', value: token });
        }

        const finalized = finalizeAnswer(raw, prepared);
        const followUps = await generateFollowUps(message, finalized.answer, prepared.analysis);

        const payload: AssistantPayload = {
          ...prepared.payloadBase,
          citations: finalized.citations,
          followUpSuggestions: followUps,
          grounded: finalized.grounding.grounded && prepared.usedSources.length > 0,
          latencyMs: Date.now() - started,
        };

        const saved = await appendAssistantMessage(session.id, finalized.answer, payload, {
          latencyMs: payload.latencyMs,
        });

        // The streamed tokens are the raw model output; the finalized answer
        // may differ after citation renumbering and overclaim softening, so
        // the client replaces its buffer with `answer` on completion.
        send({ type: 'done', messageId: saved.id, answer: finalized.answer, payload });

        await logRetrieval(session.id, saved.id, message, prepared, payload, started);
      } catch (err) {
        logger.error('Chat stream failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
        send({
          type: 'error',
          error:
            'Something went wrong while answering. Please try again, or call Golden Sierra at (916) 746-7722.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

async function logRetrieval(
  sessionId: string,
  messageId: string,
  query: string,
  prepared: Awaited<ReturnType<typeof prepareTurn>>,
  payload: AssistantPayload,
  started: number,
): Promise<void> {
  await prisma.retrievalLog
    .create({
      data: {
        sessionId,
        messageId,
        query,
        rewrittenQuery: prepared.analysis.rewrittenQuery,
        intent: prepared.analysis.intent,
        filters: {} as never,
        results: prepared.usedSources.map((source) => ({
          chunkId: source.chunkId,
          documentId: source.documentId,
          title: source.title,
          url: source.url,
          score: source.score,
          rerankScore: source.rerankScore ?? null,
          used: source.used,
        })) as never,
        vectorMs: prepared.timings.retrieveMs ?? null,
        rerankMs: prepared.timings.rerankMs ?? null,
        totalMs: Date.now() - started,
        grounded: payload.grounded,
      },
    })
    .catch((err) => logger.warn('Could not write retrieval log', { error: String(err) }));
}
