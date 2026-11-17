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
import { completeTurn, prepareTurn, streamAnswer, type PreparedTurn } from '@/lib/rag/generate';
import { routeMessage } from '@/lib/rag/routing';
import { lookupFlowPayload, readFlow, runGuidedTurn } from '@/lib/conversation/flow';
import type { AssistantPayload, UserProfile } from '@/types/chat';
import type { FlowState } from '@/types/flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat
 *
 * Factual questions are answered by the strict document pipeline; personal workforce situations go
 * through the guided conversation (src/lib/conversation/flow.ts). Both return the same payload, with
 * the structured conversation state in `payload.flow`.
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
  /** "Show results now" — recommendations from what is known so far. */
  forceResults: z.boolean().optional(),
  /** Chosen on the mode screen: helping someone (third person) or looking for myself (second person). */
  mode: z.enum(['self', 'helper']).optional(),
});

type Produced = { answer: string; payload: AssistantPayload; prepared: PreparedTurn | null; profile: UserProfile & { flow: FlowState } };

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

  const { session, profile: storedProfile, history } = await loadSession(body.sessionToken);
  // Guided-conversation state lives with the session (per user/session, never in the vector store).
  const { flow: storedFlow, ...profile } = storedProfile as UserProfile & { flow?: unknown };
  const stored = readFlow(storedFlow);
  // The explicit choice wins over inference; it is fixed for the conversation once made.
  const flow = body.mode && stored.stage === 'START' ? { ...stored, context: { ...stored.context, mode: body.mode } } : stored;

  const started = Date.now();
  await appendUserMessage(session.id, message);

  // A direct factual question is answered from the documents; a personal situation (or a reply to
  // the assistant's own question once a guided conversation is under way) goes through the guided flow.
  const route = body.forceResults
    ? ({ kind: 'personal' } as const)
    : // Choosing a mode means they came to describe a situation: ambiguous messages go to the guided
      // flow. Direct questions ("What is Orbit?") are still recognised and answered from the documents.
      routeMessage(message, { fallback: flow.stage === 'START' && !body.mode ? 'factual' : 'personal' });

  const produce = async (): Promise<Produced> => {
    if (route.kind === 'personal') {
      const guided = await runGuidedTurn({ message, history, flow, forceResults: body.forceResults });
      return { answer: guided.answer, payload: guided.payload, prepared: guided.prepared, profile: { ...profile, flow: guided.flow } };
    }
    const prepared = await prepareTurn({ message, history, profile, sessionId: session.id });
    let raw = '';
    for await (const token of streamAnswer(prepared)) raw += token;
    const { answer, payload } = await completeTurn(prepared, raw, message, started);
    payload.flow = lookupFlowPayload(flow, route.kind === 'smalltalk' ? 'smalltalk' : 'factual');
    return { answer, payload, prepared, profile: { ...prepared.profile, flow } };
  };

  const finish = async (out: Produced) => {
    await updateProfile(session.id, out.profile as UserProfile);
    const saved = await appendAssistantMessage(session.id, out.answer, out.payload, { latencyMs: out.payload.latencyMs });
    if (out.prepared) await logRetrieval(session.id, saved.id, message, out.prepared, out.payload, started);
    return saved;
  };

  // ── Non-streaming path (used by the admin console and the eval harness) ──
  if (!body.stream) {
    const out = await produce();
    const saved = await finish(out);
    return NextResponse.json({ messageId: saved.id, answer: out.answer, payload: out.payload });
  }

  // ── Streaming path ──
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        // Evidence is only shown once the answer has been verified against it.
        send({ type: 'meta', recommendations: [], sources: [], citations: [], conflicts: [] });
        // Buffered, not streamed: the text is verified against the retrieved
        // chunks first, so nothing unsupported is ever shown, even briefly.
        const out = await produce();
        const saved = await finish(out);
        send({ type: 'token', value: out.answer });
        send({ type: 'done', messageId: saved.id, answer: out.answer, payload: out.payload });
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
  prepared: PreparedTurn,
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
        filters: prepared.diagnostics.filters as never,
        // Every candidate with its fate and scores, so a response can be audited
        // against PostgreSQL and Qdrant after the fact.
        results: prepared.diagnostics.candidates.map((c) => ({
          chunkId: c.chunkId,
          documentId: c.documentId,
          title: c.title,
          url: c.url,
          similarity: c.similarity,
          fusedScore: c.fusedScore,
          lexicalCoverage: c.lexicalCoverage,
          llmRelevance: c.llmRelevance,
          status: c.status,
          used: c.status === 'used',
        })) as never,
        vectorMs: prepared.timings.retrieveMs ?? null,
        rerankMs: prepared.timings.rerankMs ?? null,
        totalMs: Date.now() - started,
        grounded: payload.grounded,
      },
    })
    .catch((err) => logger.warn('Could not write retrieval log', { error: String(err) }));
}
