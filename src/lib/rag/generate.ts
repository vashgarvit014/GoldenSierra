import { getLlmClient } from '../ai/client';
import { env, hasLlm } from '../env';
import { logger } from '../logger';
import { withTimeout } from '../errors';
import { extractJsonObject } from '../ai/json';
import {
  FALLBACK_FOLLOW_UPS,
  FOLLOW_UP_SYSTEM,
  NO_EVIDENCE_INSTRUCTION,
  OFF_TOPIC_INSTRUCTION,
  RESPONSE_STYLE,
  SYSTEM_PROMPT,
  STRICT_FACTUAL_PROMPT,
  STRICT_GUIDANCE_ADDENDUM,
  structuredTokenBudget,
  buildContextBlock,
  buildProfileBlock,
  buildProgramBlock,
} from '../ai/prompts';
import {
  checkGrounding,
  deduplicateSources,
  detectConflicts,
  prioritizeByFreshness,
  softenOverclaims,
  type GroundingReport,
} from './consolidate';
import { analyzeQuery, mergeProfile } from './understand';
import { retrieve, retrieveStructuredPrograms } from './retrieve';
import {
  KB_UNAVAILABLE_TEXT,
  NO_ANSWER_TEXT,
  SMALL_TALK_TEXT,
  THRESHOLDS,
  contentTerms,
  isSmallTalk,
  relevanceGate, namedUnknowns,
  outsideKnowledgeBase,
  profileTerms,
  validateChunks,
  verifyAnswer,
} from './strict';
import { isGuidanceRequest } from './routing';
import { collectionStats } from '../vector/qdrant';
import { rerank } from './rerank';
import { matchPrograms, toRecommendations } from '../programs/matching';
import type { AssistantPayload, CandidateStatus, ChatTurn, QueryAnalysis, RetrievedSource, TurnDiagnostics, UserProfile } from '@/types/chat';

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
  /** Restrict retrieval to these knowledge sources (admin source-level testing). */
  sourceIds?: string[];
};

export type GenerateResult = {
  answer: string;
  payload: AssistantPayload;
  analysis: QueryAnalysis;
  grounding: GroundingReport;
  usage: { promptTokens?: number; completionTokens?: number };
  diagnostics?: TurnDiagnostics;
};

/** Shared preparation for both streaming and non-streaming paths. */
export type PreparedTurn = {
  analysis: QueryAnalysis;
  profile: UserProfile;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  payloadBase: Omit<AssistantPayload, 'latencyMs' | 'grounded'>;
  usedSources: AssistantPayload['sources'];
  timings: Record<string, number>;
  mode: 'factual' | 'guidance';
  /**
   * When set, the answer is already decided and the model is not called:
   * greetings, an empty or unreachable knowledge base, or no relevant evidence.
   */
  preAnswer: string | null;
  diagnostics: TurnDiagnostics;
  /** Set by the guided conversation, which asks its own follow-up question. */
  skipFollowUps?: boolean;
};

const TEXT_PREVIEW = 700;

function emptyPayloadBase(analysis: QueryAnalysis, profile: UserProfile): PreparedTurn['payloadBase'] {
  return {
    intent: analysis.intent,
    confidence: analysis.confidence,
    recommendations: [],
    citations: [],
    sources: [],
    followUpSuggestions: [],
    conflicts: [],
    profile,
    clarifyingQuestion: null,
  };
}

export async function prepareTurn(input: GenerateInput): Promise<PreparedTurn> {
  const started = Date.now();
  const history = input.history.map((t) => ({ role: t.role, content: t.content }));

  const baseDiagnostics = (analysis: QueryAnalysis, mode: 'factual' | 'guidance', terms: string[]): TurnDiagnostics => ({
    query: input.message,
    rewrittenQuery: analysis.rewrittenQuery,
    intent: analysis.intent,
    mode,
    filters: {},
    queryTerms: terms,
    thresholds: {
      minLexicalCoverage: THRESHOLDS.minLexicalCoverage,
      minLlmRelevance: THRESHOLDS.minLlmRelevance,
      semanticOverride: THRESHOLDS.semanticOverride,
    },
    candidates: [],
    citationMap: [],
    unsupportedSentences: [],
    noAnswerReason: null,
    rerankStrategy: null,
  });

  // A greeting needs no analysis, no retrieval and no model.
  if (isSmallTalk(input.message)) {
    const analysis: QueryAnalysis = {
      intent: 'general_info', confidence: 1, rewrittenQuery: input.message, keywords: [], profileUpdates: {},
      missingInfo: null, isMultiPart: false, subQuestions: [],
    };
    const diagnostics = baseDiagnostics(analysis, 'factual', []);
    diagnostics.noAnswerReason = 'small_talk';
    return {
      analysis, profile: input.profile, messages: [], payloadBase: emptyPayloadBase(analysis, input.profile),
      usedSources: [], timings: { analyzeMs: 0, retrieveMs: 0, rerankMs: 0 }, mode: 'factual',
      preAnswer: SMALL_TALK_TEXT, diagnostics,
    };
  }

  const analysis = await analyzeQuery(input.message, history, input.profile);
  const profile = mergeProfile(input.profile, analysis.profileUpdates);
  const analyzeMs = Date.now() - started;

  // Intent routes the conversation (lookup vs personal guidance). It never
  // decides whether to search: every question is searched, including ones the
  // classifier calls off-topic, because the knowledge base can hold any subject.
  const mode: 'factual' | 'guidance' = isGuidanceRequest(input.message) ? 'guidance' : 'factual';
  // On a first message the user's own words are the query: the model's rewrite adds nothing there and
  // drifts between runs (it likes to append the agency's name, which matches every page). It is only
  // needed to resolve a follow-up ("how much does it pay?") from the conversation.
  const query = history.length === 0 ? input.message : analysis.rewrittenQuery || input.message;
  const terms = contentTerms(query);
  const diagnostics = baseDiagnostics(analysis, mode, terms.map((t) => t.raw));
  diagnostics.rewrittenQuery = query;

  const finish = (reason: string, answer: string, partial: Partial<PreparedTurn> = {}): PreparedTurn => {
    diagnostics.noAnswerReason = reason;
    logger.info('RAG turn without an answer from evidence', {
      reason, mode, query: input.message.slice(0, 160),
      candidates: diagnostics.candidates.length,
    });
    return {
      analysis, profile, messages: [], payloadBase: emptyPayloadBase(analysis, profile), usedSources: [],
      timings: { analyzeMs, retrieveMs: 0, rerankMs: 0 }, mode, preAnswer: answer, diagnostics, ...partial,
    };
  };

  const genericLookup = mode === 'factual' && (analysis.intent === 'off_topic' || analysis.intent === 'general_info');
  const retrievalAnalysis: QueryAnalysis = {
    ...analysis,
    rewrittenQuery: query,
    // Generic or unrecognised lookups search with the user's own words only: no intent
    // vocabulary, no category bias. A confidently recognised domain intent (contact,
    // eligibility, financial aid…) keeps its vocabulary expansion, which helps recall.
    intent: genericLookup ? 'off_topic' : analysis.intent,
    keywords: [...new Set([...analysis.keywords, ...terms.map((t) => t.raw)])].slice(0, 10),
  };

  // 1. Candidates from Qdrant (all permitted sources unless a source filter was explicitly given).
  const retrieveStart = Date.now();
  let retrieval;
  try {
    retrieval = await retrieve(retrievalAnalysis, profile, {
      sourceIds: input.sourceIds,
      expand: !genericLookup,
      originalQuery: input.message,
    });
  } catch (err) {
    logger.error('Knowledge base search failed', { error: err instanceof Error ? err.message : String(err) });
    return finish('knowledge_base_unavailable', KB_UNAVAILABLE_TEXT);
  }
  diagnostics.filters = {
    ...retrieval.filters,
    sourceIds: input.sourceIds ?? 'all permitted sources',
    audience: 'ranking preference only (not a filter)',
  };
  if (retrieval.vectorQueries > 0 && retrieval.vectorFailures >= retrieval.vectorQueries) {
    return finish('knowledge_base_unavailable', KB_UNAVAILABLE_TEXT);
  }
  const candidates = retrieval.sources;
  if (candidates.length === 0) {
    const stats = await collectionStats();
    return finish(stats.exists && stats.vectorCount > 0 ? 'no_candidates' : 'empty_knowledge_base', NO_ANSWER_TEXT);
  }

  // 2. PostgreSQL validation: reject stale, deleted and non-public chunks.
  const { valid, rejected } = await validateChunks(candidates);
  const status = new Map<string, { status: CandidateStatus; reason: string | null }>();
  for (const r of rejected) status.set(r.chunkId, { status: r.status, reason: r.reason });

  // 3. Relevance gate (deterministic), then the model's relevance judgement via reranking.
  const termProfile = await profileTerms(terms);
  const gate = relevanceGate(terms, valid, termProfile);
  for (const [chunkId, reason] of gate.below) status.set(chunkId, { status: 'below_relevance', reason });

  let relevant = gate.relevant;
  const named = namedUnknowns(input.message, termProfile.unknown);
  const unknown = outsideKnowledgeBase(termProfile, named) ? termProfile.unknown : [];
  if (unknown.length && relevant.length) {
    // Most of what the question asks about appears nowhere in the knowledge base.
    for (const s of relevant) status.set(s.chunkId, { status: 'below_relevance', reason: `"${unknown.join('", "')}" does not appear anywhere in the knowledge base` });
    relevant = [];
  }

  let ranked: RetrievedSource[] = [];
  let strategy = 'none';
  let rerankMs = 0;
  if (relevant.length) {
    const result = await rerank(retrievalAnalysis, relevant, env.RETRIEVAL_FINAL_K, { forceLlm: true });
    strategy = result.strategy;
    rerankMs = result.rerankMs;
    ranked = result.sources;
    if (strategy === 'llm') {
      // The relevance model is a noisy judge (scores vary run to run and are
      // sometimes missing), so it only vetoes: a passage it explicitly scored
      // below the bar is dropped, an unscored one is not penalised, and if it
      // judged the evidence irrelevant across the board the answer is "not found".
      // A passage that contains every one of the question's terms (and the question has a distinctive
      // term) is not overridden by the score: the model's judgement varies run to run, and a veto on
      // clear deterministic evidence is how "what is orbit" intermittently found nothing.
      const strongEvidence = (s: RetrievedSource) =>
        termProfile.distinctive.length > 0 && (gate.coverage.get(s.chunkId) ?? 0) >= 0.99 && (s.similarity ?? 0) >= 0.55;
      const judged = ranked.filter((s) => s.llmRelevance !== undefined);
      const low = (s: RetrievedSource) => (s.llmRelevance ?? 10) < THRESHOLDS.minLlmRelevance && !strongEvidence(s);
      if (judged.length > 0 && judged.length >= ranked.length / 2 && judged.every(low)) {
        for (const s of ranked) status.set(s.chunkId, { status: 'below_relevance', reason: `relevance model scored every passage below ${THRESHOLDS.minLlmRelevance}/10` });
        ranked = [];
      } else {
        ranked = ranked.filter((s) => {
          if (!low(s)) return true;
          status.set(s.chunkId, { status: 'below_relevance', reason: `relevance ${s.llmRelevance}/10 is below ${THRESHOLDS.minLlmRelevance}` });
          return false;
        });
      }
    }
  }
  diagnostics.rerankStrategy = strategy;

  const consolidated = prioritizeByFreshness(deduplicateSources(ranked));
  const usedSources = consolidated.slice(0, env.RETRIEVAL_FINAL_K).map((source) => ({ ...source, used: true }));
  for (const s of usedSources) status.set(s.chunkId, { status: 'used', reason: null });

  // Diagnostics: every candidate with its fate, similarity, coverage and text.
  const byId = new Map<string, RetrievedSource>();
  for (const s of valid) byId.set(s.chunkId, s);
  diagnostics.candidates = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((c) => {
      const v = byId.get(c.chunkId) ?? c;
      const st = status.get(c.chunkId) ?? { status: 'not_selected' as CandidateStatus, reason: 'ranked below the passages used' };
      return {
        chunkId: c.chunkId,
        documentId: c.documentId,
        sourceId: v.sourceId ?? null,
        title: v.title,
        url: v.url,
        headingPath: v.headingPath,
        similarity: c.similarity ?? null,
        fusedScore: Number(c.score.toFixed(4)),
        lexicalCoverage: Number((gate.coverage.get(c.chunkId) ?? 0).toFixed(2)),
        llmRelevance: ranked.find((r) => r.chunkId === c.chunkId)?.llmRelevance ?? null,
        status: st.status,
        reason: st.reason,
        text: v.snippet.slice(0, TEXT_PREVIEW),
      };
    });

  logger.info('RAG retrieval', {
    query: input.message.slice(0, 160),
    rewritten: query.slice(0, 160),
    intent: analysis.intent,
    mode,
    sourceFilter: input.sourceIds ?? null,
    candidates: candidates.length,
    validated: valid.length,
    rejectedByPostgres: rejected.map((r) => ({ chunkId: r.chunkId, status: r.status })),
    relevant: relevant.length,
    used: usedSources.map((s) => ({ chunkId: s.chunkId, documentId: s.documentId, similarity: s.similarity, llmRelevance: s.llmRelevance ?? null })),
    rerank: strategy,
  });

  const retrieveMs = Date.now() - retrieveStart - rerankMs;
  if (usedSources.length === 0) {
    const reason = rejected.length === candidates.length
      ? 'all_candidates_failed_postgres_validation'
      : unknown.length
        ? `unknown_term:${unknown.join(',')}`
        : 'no_relevant_chunk';
    return finish(reason, NO_ANSWER_TEXT, { timings: { analyzeMs, retrieveMs, rerankMs } });
  }

  const conflicts = detectConflicts(usedSources);
  const contextBlock = buildContextBlock(usedSources);

  // ── Factual lookup: sources and question only. No persona, no program promotion. ──
  if (mode === 'factual') {
    return {
      analysis, profile, mode, preAnswer: null, diagnostics, usedSources,
      timings: { analyzeMs, retrieveMs, rerankMs },
      messages: [
        { role: 'system', content: STRICT_FACTUAL_PROMPT },
        ...recentHistory(input.history),
        { role: 'user', content: `${contextBlock}\n\n---\n\nQUESTION:\n${input.message}${analysis.rewrittenQuery && analysis.rewrittenQuery !== input.message ? `\n(Understood in context as: ${analysis.rewrittenQuery})` : ''}` },
      ],
      payloadBase: {
        ...emptyPayloadBase(analysis, profile),
        citations: [],
        sources: usedSources,
        conflicts,
      },
    };
  }

  // ── Personalised guidance: same evidence rules, plus verified program records. ──
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

  const instructions: string[] = [];
  if (analysis.isMultiPart) {
    instructions.push(`This message asks more than one thing (${analysis.subQuestions.length} parts). Address each one — briefly — in a single flowing answer, not as separate mini-answers.`);
  }
  if (analysis.missingInfo) {
    instructions.push(`Answer as fully as the sources allow, then close by asking this one question: ${analysis.missingInfo}`);
  }
  if (conflicts.length) {
    instructions.push(`The sources disagree about: ${conflicts.map((c) => c.topic).join(', ')}. Say that the published information differs and suggest confirming with staff. Do not pick one silently.`);
  }

  const userContent = [
    buildProfileBlock(profile, analysis.intent),
    buildProgramBlock(recommendations),
    contextBlock,
    instructions.length ? `ADDITIONAL INSTRUCTIONS:\n${instructions.join('\n')}` : '',
    `THE PERSON ASKED:\n${input.message}`,
  ].filter(Boolean).join('\n\n---\n\n');

  return {
    analysis, profile, mode, preAnswer: null, diagnostics, usedSources,
    timings: { analyzeMs, retrieveMs, rerankMs },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + STRICT_GUIDANCE_ADDENDUM },
      ...recentHistory(input.history),
      { role: 'user', content: userContent },
    ],
    payloadBase: {
      ...emptyPayloadBase(analysis, profile),
      recommendations,
      sources: usedSources,
      conflicts,
      clarifyingQuestion: analysis.missingInfo,
    },
  };
}

/** Non-streaming generation, used by the eval harness and the admin console. */
export async function generateAnswer(input: GenerateInput): Promise<GenerateResult> {
  const started = Date.now();
  const prepared = await prepareTurn(input);

  let raw = '';
  let usage: GenerateResult['usage'] = {};

  if (prepared.preAnswer === null) {
    if (!hasLlm()) return buildUnavailableResult(prepared, started);
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
  }

  const done = await completeTurn(prepared, raw, input.message, started);
  return { answer: done.answer, grounding: done.grounding, analysis: prepared.analysis, usage, payload: done.payload, diagnostics: prepared.diagnostics };
}

/**
 * Turns the model's raw text into the final, verified response.
 *
 * The model's text is never shown as written. It is checked against the chunks
 * it was given: unsupported sentences are removed, citations are rebuilt from
 * the chunks that actually support each claim, and "no answer" becomes the
 * fixed sentence. The payload then carries only evidence that survived.
 */
export async function completeTurn(
  prepared: PreparedTurn,
  raw: string,
  message: string,
  started: number,
): Promise<{ answer: string; payload: AssistantPayload; grounding: GroundingReport }> {
  let finalized = finalizeAnswer(raw, prepared);

  // The model sometimes fuses a supported fact with an unsupported one in a single sentence, and the
  // verifier then (correctly) removes the whole sentence — leaving nothing even though the sources do
  // contain the answer. Ask once for a version with one fact per sentence, and verify that exactly as
  // strictly as the first. A reply of NO_ANSWER, or anything still unsupported, stays a refusal.
  if (finalized.noAnswer && prepared.diagnostics.noAnswerReason === 'no_supported_claims' && prepared.diagnostics.unsupportedSentences.length > 0 && hasLlm()) {
    const retry = await repairAnswer(prepared, raw, prepared.diagnostics.unsupportedSentences);
    if (retry) {
      prepared.diagnostics.noAnswerReason = null;
      const second = finalizeAnswer(retry, prepared);
      prepared.diagnostics.repair = second.noAnswer ? 'failed' : 'recovered';
      logger.info('Answer repair pass', { outcome: prepared.diagnostics.repair });
      finalized = second;
    }
  }
  const answered = !finalized.noAnswer;

  // Follow-up suggestions only make sense for guidance; a lookup stays a lookup.
  const followUps =
    answered && prepared.mode === 'guidance' && !prepared.skipFollowUps ? await generateFollowUps(message, finalized.answer, prepared.analysis) : [];

  const payload: AssistantPayload = {
    ...prepared.payloadBase,
    recommendations: answered ? prepared.payloadBase.recommendations : [],
    sources: answered ? prepared.usedSources : [],
    citations: finalized.citations,
    followUpSuggestions: followUps,
    clarifyingQuestion: answered ? prepared.payloadBase.clarifyingQuestion : null,
    grounded: answered && finalized.grounding.grounded && prepared.usedSources.length > 0,
    latencyMs: Date.now() - started,
  };
  return { answer: finalized.answer, payload, grounding: finalized.grounding };
}

const REPAIR_NOTE = (rejected: string[]) =>
  `Some sentences of your answer were removed because the SOURCES do not state them:\n${rejected.slice(0, 4).map((r) => `- ${r.slice(0, 220)}`).join('\n')}\n\n` +
  'Write the answer again. Use only what the SOURCES state explicitly, one fact per sentence, copying names, numbers and phone numbers exactly, and cite every sentence like [1]. Do not combine details from different places into one claim, and do not add anything that is not written in the SOURCES. If the SOURCES do not state the answer, reply with exactly: NO_ANSWER';

/** One bounded retry. Returns null if the model is unreachable; the caller then keeps the refusal. */
async function repairAnswer(prepared: PreparedTurn, raw: string, rejected: string[]): Promise<string | null> {
  try {
    const response = await withTimeout(
      getLlmClient().chat.completions.create({
        model: env.LLM_MODEL,
        temperature: 0,
        max_tokens: env.LLM_MAX_TOKENS,
        messages: [...prepared.messages, { role: 'assistant', content: raw }, { role: 'user', content: REPAIR_NOTE(rejected) }],
      }),
      30_000,
      'answer repair',
    );
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.warn('Answer repair failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Verification, in a fixed order: soften eligibility overclaims, verify every
 * claim and rebuild citations from the supporting chunks, then run the
 * phone/e-mail/link checks on the exact text the user will see.
 */
export function finalizeAnswer(raw: string, prepared: PreparedTurn) {
  // Decided without the model (greeting, empty/unavailable KB, no relevant evidence).
  if (prepared.preAnswer !== null) {
    return {
      answer: prepared.preAnswer,
      citations: [] as AssistantPayload['citations'],
      grounding: { grounded: true, issues: [], unsupportedClaims: [] } as GroundingReport,
      noAnswer: true,
    };
  }

  const softened = softenOverclaims(raw);
  const verified = verifyAnswer(softened, prepared.usedSources, { question: prepared.diagnostics.query });
  prepared.diagnostics.unsupportedSentences = verified.unsupported;

  if (verified.noAnswer) {
    prepared.diagnostics.noAnswerReason = verified.reason;
    logger.info('Model answer rejected', { reason: verified.reason, unsupported: verified.unsupported.length, mode: prepared.mode });
    return {
      answer: NO_ANSWER_TEXT,
      citations: [] as AssistantPayload['citations'],
      grounding: { grounded: true, issues: [], unsupportedClaims: verified.unsupported } as GroundingReport,
      noAnswer: true,
    };
  }

  prepared.diagnostics.citationMap = verified.citationMap;
  const grounding = checkGrounding(verified.answer, prepared.usedSources, prepared.payloadBase.recommendations);
  if (!grounding.grounded) {
    logger.warn('Answer failed grounding checks', { issues: grounding.issues.slice(0, 5), intent: prepared.analysis.intent });
  }
  return { answer: verified.answer, citations: verified.citations, grounding, noAnswer: false };
}

/** Streaming token source for the chat route. */
export async function* streamAnswer(
  prepared: PreparedTurn,
): AsyncGenerator<string, { raw: string }, void> {
  if (prepared.preAnswer !== null) {
    yield prepared.preAnswer;
    return { raw: prepared.preAnswer };
  }
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
        max_tokens: structuredTokenBudget(200),
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

    const parsed = extractJsonObject(response.choices[0]?.message?.content ?? '') as {
      suggestions?: unknown;
    } | null;
    // Some models return a bare array, others wrap it. Accept either.
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.suggestions)
        ? parsed.suggestions
        : null;
    if (!list) return fallback;

    const suggestions = list
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
