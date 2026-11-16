import { env } from '../env';
import { logger } from '../logger';
import { prisma } from '../db';
import { STRICT_FACTUAL_PROMPT, buildContextBlock } from '../ai/prompts';
import { deduplicateSources, detectConflicts } from '../rag/consolidate';
import { retrieve } from '../rag/retrieve';
import { KB_UNAVAILABLE_TEXT, NO_ANSWER_TEXT, THRESHOLDS, contentTerms, relevanceGate, validateChunks } from '../rag/strict';
import type { PreparedTurn } from '../rag/generate';
import type { CounselorContext } from '@/types/counselor';
import type { AssistantPayload, CandidateStatus, QueryAnalysis, Recommendation, RetrievedSource, TurnDiagnostics } from '@/types/chat';

/**
 * RETRIEVE + RECOMMEND for the guided conversation.
 *
 * Recommendations are built only from indexed, PostgreSQL-validated chunks:
 *   1. one focused search per known need (career interest, GED, finding work quickly, location…),
 *   2. PostgreSQL validation and the deterministic relevance gate on each,
 *   3. one strict generation over the union, then the same claim-by-claim verifier as factual answers
 *      (run by completeTurn), so every sentence that survives is supported and cited.
 * Program cards are shown only for catalogue programs that a cited chunk actually names.
 */

export type Focus = { key: string; label: string; query: string; /** A passage must mention this (e.g. the town) to count for this focus. */ require?: string };

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** One focused query per need the user has expressed — never a fixed list, never more than five. */
export function focusQueries(ctx: CounselorContext, message: string): Focus[] {
  const out: Focus[] = [];
  const pop = new Set(ctx.population);
  if (ctx.audience === 'employer') out.push({ key: 'employer', label: 'hiring help for a business', query: 'employer services help businesses hire and train employees' });
  if (ctx.careerInterest && !/still deciding|not sure|unsure|undecided/i.test(ctx.careerInterest)) {
    out.push({ key: 'career', label: `${ctx.careerInterest} training`, query: `${ctx.careerInterest} training career pathway` });
  }
  if (ctx.education === 'no_hs_diploma' || ctx.education === 'working_on_ged') {
    out.push({ key: 'education', label: 'finishing a GED or diploma', query: 'GED high school diploma equivalency adult education' });
  }
  if (ctx.incomeUrgency === 'immediate' || (ctx.employmentStatus === 'unemployed' && ctx.incomeUrgency !== 'can_train_first')) {
    out.push({ key: 'work', label: 'finding paid work soon', query: 'job search assistance help finding a job employment' });
  } else if (ctx.incomeUrgency === 'can_train_first') {
    out.push({ key: 'funding', label: 'paying for training', query: 'training scholarships pay for training' });
  }
  if (ctx.employmentStatus === 'laid_off' || pop.has('dislocated_worker')) {
    out.push({ key: 'layoff', label: 'support after a layoff', query: 'layoff assistance dislocated workers' });
  }
  if (pop.has('veteran')) out.push({ key: 'veteran', label: 'veteran services', query: 'veterans priority of service' });
  if (pop.has('former_foster_youth') || pop.has('youth') || ctx.ageBand === '18_24' || ctx.ageBand === 'under_18') {
    out.push({ key: 'youth', label: 'services for young adults', query: `youth program young adults${pop.has('former_foster_youth') ? ' foster youth' : ''}` });
  }
  if (pop.has('disability')) out.push({ key: 'disability', label: 'disability accommodations', query: 'disability services accommodations' });
  const place = ctx.city ? title(ctx.city) : ctx.county ? `${ctx.county} County` : null;
  if (place && (ctx.transportation === 'none' || ctx.transportation === 'transit_only' || out.length < 3)) {
    const town = ctx.city ? title(ctx.city) : ctx.county!;
    out.push({ key: 'location', label: `services in or near ${place}`, query: `${town} job services events workshops`, require: town.toLowerCase() });
  }
  if (out.length === 0) out.push({ key: 'request', label: 'the request', query: message.slice(0, 300) });
  return out.slice(0, 5);
}

/** What the strict generator is asked: the situation as facts, and the instruction to name only what the sources describe. */
export function guidedQuestion(ctx: CounselorContext, focuses: Focus[]): string {
  const who = ctx.mode === 'helper' ? 'the person being helped' : 'the person asking';
  return [
    `Which services, programs or resources described in the SOURCES could help ${who} with: ${focuses.map((f) => f.label).join('; ')}?`,
    'Name each relevant service exactly as the sources name it, say in one sentence what the sources say it offers, and cite it.',
    'Do not say anyone is eligible or qualifies. Skip any need the sources do not address — do not mention services the sources do not describe.',
    'If at least one source describes a relevant service, answer with those services only. Reply NO_ANSWER only when none of the sources describes any relevant service.',
  ].join(' ');
}

const PER_FOCUS = 2;
const MAX_SOURCES = 6;

/**
 * Builds a PreparedTurn for the strict generator from the conversation context.
 * Returns a refusal-shaped turn (preAnswer = null, no sources) when nothing indexed is relevant —
 * the caller then states the knowledge limitation instead of recommending anything.
 */
export async function prepareGuidedResults(ctx: CounselorContext, message: string, extra?: string): Promise<{ prepared: PreparedTurn; focuses: Focus[]; focusOf: Map<string, Focus> }> {
  const started = Date.now();
  const focuses = focusQueries(ctx, message);
  if (extra?.trim() && !focuses.some((f) => f.key === 'request')) focuses.unshift({ key: 'request', label: 'the follow-up request', query: extra.slice(0, 300) });
  const question = guidedQuestion(ctx, focuses);
  const analysis: QueryAnalysis = {
    intent: ctx.audience === 'employer' ? 'employer_hiring' : 'find_training',
    confidence: 0.8,
    rewrittenQuery: focuses.map((f) => f.query).join(' | '),
    keywords: [],
    profileUpdates: {},
    missingInfo: null,
    isMultiPart: false,
    subQuestions: [],
  };
  const diagnostics: TurnDiagnostics = {
    query: question,
    rewrittenQuery: analysis.rewrittenQuery,
    intent: analysis.intent,
    mode: 'guidance',
    filters: { accessLevels: ['PUBLIC'], focuses: focuses.map((f) => f.key) },
    queryTerms: [],
    thresholds: { minLexicalCoverage: THRESHOLDS.minLexicalCoverage, minLlmRelevance: THRESHOLDS.minLlmRelevance, semanticOverride: THRESHOLDS.semanticOverride },
    candidates: [],
    citationMap: [],
    unsupportedSentences: [],
    noAnswerReason: null,
    rerankStrategy: 'gate-per-focus',
  };

  const focusOf = new Map<string, Focus>();
  const picked: RetrievedSource[] = [];
  const statuses: TurnDiagnostics['candidates'] = [];
  let failures = 0;

  const perFocus = await Promise.all(
    focuses.map(async (focus) => {
      try {
        const terms = contentTerms(focus.query);
        const r = await retrieve({ ...analysis, rewrittenQuery: focus.query, intent: 'off_topic' }, {}, { expand: false });
        if (r.vectorQueries > 0 && r.vectorFailures >= r.vectorQueries) failures++;
        const { valid, rejected } = await validateChunks(r.sources);
        const gate = relevanceGate(terms, valid);
        return { focus, gate, rejected, valid };
      } catch (err) {
        failures++;
        logger.warn('Guided retrieval failed for a focus', { focus: focus.key, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }),
  );

  for (const res of perFocus) {
    if (!res) continue;
    const ranked = [...res.gate.relevant]
      .filter((s) => !res.focus.require || `${s.title} ${s.headingPath ?? ''} ${s.snippet}`.toLowerCase().includes(res.focus.require))
      .sort((a, b) => b.score - a.score);
    let taken = 0;
    for (const s of ranked) {
      if (taken >= PER_FOCUS) break;
      if (picked.some((p) => p.chunkId === s.chunkId)) continue;
      picked.push(s);
      focusOf.set(s.chunkId, res.focus);
      taken++;
    }
    const mark = (s: RetrievedSource, status: CandidateStatus, reason: string | null) =>
      statuses.push({
        chunkId: s.chunkId, documentId: s.documentId, sourceId: s.sourceId ?? null, title: s.title, url: s.url, headingPath: s.headingPath,
        similarity: s.similarity ?? null, fusedScore: Number(s.score.toFixed(4)), lexicalCoverage: Number((res.gate.coverage.get(s.chunkId) ?? 0).toFixed(2)),
        llmRelevance: null, status, reason, text: s.snippet.slice(0, 400),
      });
    for (const s of res.valid.slice(0, 8)) {
      const below = res.gate.below.get(s.chunkId);
      mark(s, focusOf.get(s.chunkId) === res.focus ? 'used' : below ? 'below_relevance' : 'not_selected', below ?? `focus: ${res.focus.key}`);
    }
  }

  const usedSources = deduplicateSources(picked)
    .slice(0, Math.min(MAX_SOURCES, env.RETRIEVAL_FINAL_K))
    .map((s) => ({ ...s, used: true }));
  diagnostics.candidates = statuses.slice(0, 40);

  const payloadBase: PreparedTurn['payloadBase'] = {
    intent: analysis.intent,
    confidence: analysis.confidence,
    recommendations: [],
    citations: [],
    sources: usedSources,
    followUpSuggestions: [],
    conflicts: detectConflicts(usedSources),
    profile: {},
    clarifyingQuestion: null,
  };

  const prepared: PreparedTurn = {
    analysis,
    profile: {},
    mode: 'guidance',
    preAnswer: null,
    diagnostics,
    usedSources,
    skipFollowUps: true,
    timings: { analyzeMs: 0, retrieveMs: Date.now() - started, rerankMs: 0 },
    messages: [
      { role: 'system', content: STRICT_FACTUAL_PROMPT },
      { role: 'user', content: `${buildContextBlock(usedSources)}\n\n---\n\nQUESTION:\n${question}` },
    ],
    payloadBase,
  };

  if (usedSources.length === 0) {
    const unavailable = failures >= focuses.length;
    diagnostics.noAnswerReason = unavailable ? 'knowledge_base_unavailable' : 'no_relevant_chunk';
    prepared.preAnswer = unavailable ? KB_UNAVAILABLE_TEXT : NO_ANSWER_TEXT;
    prepared.messages = [];
  }
  logger.info('Guided retrieval', { focuses: focuses.map((f) => f.key), used: usedSources.map((s) => ({ chunkId: s.chunkId, focus: focusOf.get(s.chunkId)?.key })) });
  return { prepared, focuses, focusOf };
}

/** First sentence of the chunk that names the program — verbatim indexed text, never catalogue copy. */
function sentenceNaming(text: string, name: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(flat.lastIndexOf('. ', i) + 2, 0);
  const endDot = flat.indexOf('. ', i);
  const sentence = flat.slice(start, endDot < 0 ? undefined : endDot + 1).trim();
  return sentence.length > 240 ? `${sentence.slice(0, 237).trimEnd()}…` : sentence;
}

/**
 * Compact recommendation cards, one per catalogue program that a *cited* chunk names.
 * Everything on the card comes from the cited chunk or the user's own stated need; nothing from
 * the seeded catalogue text, which is not indexed knowledge.
 */
export async function cardsFromCitations(
  payload: Pick<AssistantPayload, 'citations' | 'sources'>,
  focusOf: Map<string, Focus>,
  mode: CounselorContext['mode'],
): Promise<Recommendation[]> {
  const cited = new Set(payload.citations.flatMap((c) => c.chunkIds ?? []));
  const chunks = payload.sources.filter((s) => cited.has(s.chunkId));
  if (chunks.length === 0) return [];
  let programs: { slug: string; name: string; category: { slug: string } | null }[] = [];
  try {
    programs = await prisma.program.findMany({ where: { status: 'ACTIVE' }, select: { slug: true, name: true, category: { select: { slug: true } } } });
  } catch (err) {
    logger.warn('Program catalogue unavailable for cards', { error: String(err) });
    return [];
  }
  const cards: Recommendation[] = [];
  for (const p of programs) {
    // "Paid Internships" is named "a paid internship" on the page: match the singular too.
    const base = p.name.replace(/\s*\(.*?\)\s*/g, '').trim().replace(/s$/, '');
    if (base.length < 4) continue;
    const chunk = chunks.find((c) => `${c.title} ${c.snippet}`.toLowerCase().includes(base.toLowerCase()));
    if (!chunk) continue;
    const sentence = sentenceNaming(chunk.snippet, base) ?? sentenceNaming(chunk.title, base);
    if (!sentence) continue;
    const focus = focusOf.get(chunk.chunkId);
    const citation = payload.citations.find((c) => c.chunkIds?.includes(chunk.chunkId));
    cards.push({
      programId: null,
      slug: p.slug,
      name: base,
      shortDescription: sentence,
      whyRelevant: focus
        ? `Found when looking for ${focus.label}, which ${mode === 'helper' ? 'they' : 'you'} mentioned.`
        : 'Named in a source cited above.',
      eligibility: [],
      nextSteps: null,
      officialUrl: chunk.url,
      contactPhone: null,
      requiresVerification: true,
      exclusions: [],
      category: citation ? `Source [${citation.id}]` : p.category?.slug ?? null,
    });
    if (cards.length >= 4) break;
  }
  return cards;
}
