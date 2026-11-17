import { env } from '../env';
import { logger } from '../logger';
import { prisma } from '../db';
import { STRICT_FACTUAL_PROMPT, buildContextBlock } from '../ai/prompts';
import { deduplicateSources, detectConflicts } from '../rag/consolidate';
import { retrieve } from '../rag/retrieve';
import { namedIn } from '../programs/link';
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
 * Program cards are shown only for catalogue programs linked to the cited chunk's document that the
 * cited chunk itself names (see programs/link.ts).
 */

export { focusQueries, type Focus } from './focus';
import { focusQueries, type Focus } from './focus';

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

async function listingDocumentIds(): Promise<Set<string>> {
  try {
    return new Set((await prisma.jobListing.findMany({ distinct: ['documentId'], select: { documentId: true } })).map((d) => d.documentId));
  } catch {
    return new Set();
  }
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
  // Documents that tabulate job listings are matched per listing (jobs/match.ts). Their chunks cut across
  // listings, so a sentence generated from them could pair one job's salary with another's employer.
  const listingDocs = await listingDocumentIds();

  const perFocus = await Promise.all(
    focuses.map(async (focus) => {
      try {
        const terms = contentTerms(focus.query);
        const r = await retrieve({ ...analysis, rewrittenQuery: focus.query, intent: 'off_topic' }, {}, { expand: false });
        if (r.vectorQueries > 0 && r.vectorFailures >= r.vectorQueries) failures++;
        const { valid, rejected } = await validateChunks(r.sources.filter((x) => !listingDocs.has(x.documentId)));
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
      .filter((s) => !res.focus.require || new RegExp(res.focus.require, 'i').test(`${s.title} ${s.headingPath ?? ''} ${s.snippet}`))
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
  const dot = flat.lastIndexOf('. ', i);
  // Start at the sentence, or after a heading breadcrumb ("Help for Job Seekers > …") that precedes it.
  const crumb = flat.lastIndexOf(' > ', i);
  const start = Math.max(dot < 0 ? 0 : dot + 2, crumb < 0 ? 0 : crumb + 3);
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
  let programs: { slug: string; name: string; category: { slug: string } | null; documents: { documentId: string }[] }[] = [];
  try {
    programs = await prisma.program.findMany({
      where: { status: 'ACTIVE', documents: { some: { documentId: { in: chunks.map((c) => c.documentId) } } } },
      select: { slug: true, name: true, category: { select: { slug: true } }, documents: { select: { documentId: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  } catch (err) {
    logger.warn('Program catalogue unavailable for cards', { error: String(err) });
    return [];
  }
  const cards: Recommendation[] = [];
  for (const p of programs) {
    // A card needs both: the cited chunk's document is linked to the program (ProgramDocument, built by
    // linkProgramsToDocuments from the same naming test), and the cited chunk itself names the program.
    const linked = new Set(p.documents.map((d) => d.documentId));
    let chunk: RetrievedSource | undefined;
    let phrase: string | null = null;
    for (const c of chunks) {
      if (!linked.has(c.documentId)) continue;
      phrase = namedIn(`${c.headingPath ?? ''} ${c.snippet}`, p);
      if (phrase) {
        chunk = c;
        break;
      }
    }
    if (!chunk || !phrase) continue;
    const base = p.name.replace(/\s*\(.*?\)\s*/g, '').trim();
    const sentence = sentenceNaming(chunk.snippet, phrase) ?? sentenceNaming(chunk.title, phrase);
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
