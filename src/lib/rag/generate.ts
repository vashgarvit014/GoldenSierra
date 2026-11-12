import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import {
  FALLBACK_FOLLOW_UPS,
  FOLLOW_UP_SYSTEM,
  NO_EVIDENCE_INSTRUCTION,
  OFF_TOPIC_INSTRUCTION,
  RESPONSE_STYLE,
  SYSTEM_PROMPT,
  buildContextBlock,
  buildProfileBlock,
  buildProgramBlock,
} from '../ai/prompts';
import {
  buildCitations,
  checkGrounding,
  deduplicateSources,
  detectConflicts,
  prioritizeByFreshness,
  reconcileCitations,
  softenOverclaims,
  type GroundingReport,
} from './consolidate';
import { analyzeQuery, mergeProfile } from './understand';
import { retrieve, retrieveStructuredPrograms, verifySourcesAreLive } from './retrieve';
import { rerank } from './rerank';
import { matchPrograms, toRecommendations } from '../programs/matching';
import type { AssistantPayload, ChatTurn, QueryAnalysis, UserProfile } from '@/types/chat';

/**
 * The orchestrator for a single assistant turn:
 *
 *   analyse -> retrieve (hybrid) -> rerank -> consolidate
 *           -> match programs (deterministic) -> generate -> verify -> follow-ups
 *
 * Generation is the only step that may be skipped or degraded: every earlier
 * step either succeeds or yields an empty result the next step can handle, so
 * a provider outage produces an honest "I can't answer that right now"
 * response rather than a 500.
 */

export type GenerateInput = {
  message: string;
  history: ChatTurn[];
  profile: UserProfile;
  sessionId?: string;
};

export type GenerateResult = {
  answer: string;
  payload: AssistantPayload;
  analysis: QueryAnalysis;
  grounding: GroundingReport;
  usage: { promptTokens?: number; completionTokens?: number };
};

/** Shared preparation for both streaming and non-streaming paths. */
export type PreparedTurn = {
  analysis: QueryAnalysis;
  profile: UserProfile;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  payloadBase: Omit<AssistantPayload, 'latencyMs' | 'grounded'>;
  usedSources: AssistantPayload['sources'];
  timings: Record<string, number>;
};

export async function prepareTurn(input: GenerateInput): Promise<PreparedTurn> {
  const started = Date.now();
  const history = input.history.map((t) => ({ role: t.role, content: t.content }));

  const analysis = await analyzeQuery(input.message, history, input.profile);
  const profile = mergeProfile(input.profile, analysis.profileUpdates);
  const analyzeMs = Date.now() - started;

  // Off-topic short-circuits before any retrieval spend.
  if (analysis.intent === 'off_topic') {
    return {
      analysis,
      profile,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recentHistory(input.history),
        { role: 'user', content: `${input.message}\n\n${OFF_TOPIC_INSTRUCTION}` },
      ],
      payloadBase: {
        intent: analysis.intent,
        confidence: analysis.confidence,
        recommendations: [],
        citations: [],
        sources: [],
        followUpSuggestions: FALLBACK_FOLLOW_UPS.off_topic,
        conflicts: [],
        profile,
        clarifyingQuestion: null,
      },
      usedSources: [],
      timings: { analyzeMs, retrieveMs: 0, rerankMs: 0 },
    };
  }

  const retrieveStart = Date.now();
  const retrieval = await retrieve(analysis, profile);
  const liveSources = await verifySourcesAreLive(retrieval.sources);
  const retrieveMs = Date.now() - retrieveStart;

  const { sources: ranked, rerankMs, strategy } = await rerank(analysis, liveSources);
  const consolidated = prioritizeByFreshness(deduplicateSources(ranked));
  const usedSources = consolidated
    .slice(0, env.RETRIEVAL_FINAL_K)
    .map((source) => ({ ...source, used: true }));

  const conflicts = detectConflicts(usedSources);

  // Structured program records — authoritative, read straight from Postgres.
  let recommendations: AssistantPayload['recommendations'] = [];
  try {
    const programs = await retrieveStructuredPrograms(analysis, profile);
    const matches = matchPrograms(programs, analysis, profile, usedSources);
    recommendations = toRecommendations(matches, RESPONSE_STYLE.maxRecommendations);
  } catch (err) {
    logger.warn('Program matching failed; answering from retrieved text only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.debug('Turn prepared', {
    intent: analysis.intent,
    retrieved: retrieval.sources.length,
    used: usedSources.length,
    recommendations: recommendations.length,
    rerank: strategy,
  });

  const contextBlock =
    usedSources.length > 0 ? buildContextBlock(usedSources) : NO_EVIDENCE_INSTRUCTION;
  const programBlock = buildProgramBlock(recommendations);
  const profileBlock = buildProfileBlock(profile, analysis.intent);

  const instructions: string[] = [];
  if (analysis.isMultiPart) {
    instructions.push(
      `This message asks more than one thing (${analysis.subQuestions.length} parts). Address each one — briefly — in a single flowing answer, not as separate mini-answers.`,
    );
  }
  if (analysis.missingInfo) {
    instructions.push(
      `Answer as fully as the sources allow, then close by asking this one question: ${analysis.missingInfo}`,
    );
  }
  if (conflicts.length) {
    instructions.push(
      `The sources disagree about: ${conflicts.map((c) => c.topic).join(', ')}. Say that the published information differs and suggest confirming with staff. Do not pick one silently.`,
    );
  }

  const userContent = [
    profileBlock,
    programBlock,
    contextBlock,
    instructions.length ? `ADDITIONAL INSTRUCTIONS:\n${instructions.join('\n')}` : '',
    `THE PERSON ASKED:\n${input.message}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  return {
    analysis,
    profile,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...recentHistory(input.history),
      { role: 'user', content: userContent },
    ],
    payloadBase: {
      intent: analysis.intent,
      confidence: analysis.confidence,
      recommendations,
      citations: buildCitations(usedSources),
      sources: usedSources,
      followUpSuggestions: [],
      conflicts,
      profile,
      clarifyingQuestion: analysis.missingInfo,
    },
    usedSources,
    timings: { analyzeMs, retrieveMs, rerankMs },
  };
}

/** Non-streaming generation, used by the eval harness and the admin console. */
export async function generateAnswer(input: GenerateInput): Promise<GenerateResult> {
  const started = Date.now();
  const prepared = await prepareTurn(input);

  if (!hasLlm()) {
    return buildUnavailableResult(prepared, started);
  }

  let raw: string;
  let usage: GenerateResult['usage'] = {};

  try {
    const client = getLlmClient();
    const response = await withTimeout(
      client.chat.completions.create({
        model: env.LLM_MODEL,
        temperature: env.LLM_TEMPERATURE,
        max_tokens: env.LLM_MAX_TOKENS,
        messages: prepared.messages,
      }),
      45_000,
      'answer generation',
    );
    raw = response.choices[0]?.message?.content?.trim() ?? '';
    usage = {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    };
  } catch (err) {
    logger.error('Answer generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return buildUnavailableResult(prepared, started);
  }

  if (!raw) return buildUnavailableResult(prepared, started);

  const finalized = finalizeAnswer(raw, prepared);
  const followUps = await generateFollowUps(input.message, finalized.answer, prepared.analysis);

  return {
    answer: finalized.answer,
    grounding: finalized.grounding,
    analysis: prepared.analysis,
    usage,
    payload: {
      ...prepared.payloadBase,
      citations: finalized.citations,
      followUpSuggestions: followUps,
      grounded: finalized.grounding.grounded && prepared.usedSources.length > 0,
      latencyMs: Date.now() - started,
    },
  };
}

/**
 * Applies the post-generation passes in a fixed order: soften overclaims,
 * reconcile citation numbering, then check grounding on the final text that
 * the user will actually see.
 */
export function finalizeAnswer(raw: string, prepared: PreparedTurn) {
  const softened = softenOverclaims(raw);
  const { answer, citations } = reconcileCitations(softened, prepared.usedSources);
  const grounding = checkGrounding(answer, prepared.usedSources);

  if (!grounding.grounded) {
    logger.warn('Answer failed grounding checks', {
      issues: grounding.issues.slice(0, 5),
      intent: prepared.analysis.intent,
    });
  }

  return { answer, citations, grounding };
}

/** Streaming token source for the chat route. */
export async function* streamAnswer(
  prepared: PreparedTurn,
): AsyncGenerator<string, { raw: string }, void> {
  if (!hasLlm()) {
    const text = unavailableMessage();
    yield text;
    return { raw: text };
  }

  const client = getLlmClient();
  let raw = '';

  try {
    const stream = await client.chat.completions.create({
      model: env.LLM_MODEL,
      temperature: env.LLM_TEMPERATURE,
      max_tokens: env.LLM_MAX_TOKENS,
      messages: prepared.messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (!delta) continue;
      raw += delta;
      yield delta;
    }
  } catch (err) {
    logger.error('Streaming generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!raw) {
      const text = unavailableMessage();
      yield text;
      return { raw: text };
    }
  }

  return { raw };
}

export async function generateFollowUps(
  question: string,
  answer: string,
  analysis: QueryAnalysis,
): Promise<string[]> {
  const fallback = FALLBACK_FOLLOW_UPS[analysis.intent] ?? FALLBACK_FOLLOW_UPS.general_info;
  if (!hasLlm()) return fallback;

  try {
    const client = getLlmClient();
    const response = await withTimeout(
      client.chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0.4,
        max_tokens: 160,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FOLLOW_UP_SYSTEM },
          {
            role: 'user',
            content: `They asked: ${question.slice(0, 400)}\n\nThe assistant replied:\n${answer.slice(0, 1600)}`,
          },
        ],
      }),
      12_000,
      'follow-up generation',
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) return fallback;

    const suggestions = parsed.suggestions
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 4 && s.length < 80)
      .slice(0, RESPONSE_STYLE.followUpCount);

    return suggestions.length ? suggestions : fallback;
  } catch {
    return fallback;
  }
}

function recentHistory(history: ChatTurn[]) {
  // Enough turns for context, few enough to keep the prompt focused and cheap.
  return history.slice(-6).map((turn) => ({
    role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: turn.content.slice(0, 1500),
  }));
}

function unavailableMessage(): string {
  return (
    "I'm not able to generate an answer right now. You can reach Golden Sierra directly at " +
    '(916) 746-7722, Monday through Thursday, 8:00am to 4:30pm, or visit https://goldensierra.com.'
  );
}

function buildUnavailableResult(prepared: PreparedTurn, started: number): GenerateResult {
  const answer = unavailableMessage();
  return {
    answer,
    analysis: prepared.analysis,
    grounding: { grounded: false, issues: ['Language model unavailable'], unsupportedClaims: [] },
    usage: {},
    payload: {
      ...prepared.payloadBase,
      followUpSuggestions: FALLBACK_FOLLOW_UPS[prepared.analysis.intent] ?? [],
      grounded: false,
      latencyMs: Date.now() - started,
    },
  };
}
