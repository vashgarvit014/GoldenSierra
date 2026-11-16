import { DocumentStatus } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import { getQdrant } from '../vector/qdrant';
import type { CandidateStatus, Citation, RetrievedSource, TurnDiagnostics } from '@/types/chat';

/**
 * Strict, evidence-only answering.
 *
 *   query → Qdrant candidates → PostgreSQL chunk validation → relevance gate
 *         → rerank → context → model → claim verification → grounded answer
 *
 * Everything in this file is deterministic (no model calls) so that the rules
 * that decide "is there evidence?" and "is this claim supported?" are testable
 * and cannot be talked out of by a prompt.
 */

export const NO_ANSWER_TEXT = "I couldn't find information about that in the currently indexed knowledge base.";
export const KB_UNAVAILABLE_TEXT =
  "I can't reach the knowledge base right now, so I can't answer that. Please try again in a moment.";
export const SMALL_TALK_TEXT = "Hello! Ask me a question and I'll answer it from the indexed knowledge base.";
/** What the model must output, verbatim, when the sources do not answer the question. */
export const NO_ANSWER_SENTINEL = 'NO_ANSWER';

export const THRESHOLDS = {
  /** Share of the question's distinctive terms a passage must contain to count as relevant on its own. */
  minLexicalCoverage: 0.5,
  /** A semantically close passage may pass with a little term overlap… */
  semanticOverride: 0.62,
  /** …provided at least this much of the question's vocabulary is present… */
  semanticMinCoverage: 0.2,
  /** …and a very close one passes on meaning alone (conversational questions share few literal words with their answers). */
  semanticAlone: 0.7,
  /** LLM relevance (0–10): below this the passage is judged irrelevant (3 = same topic is NOT a veto; 0–2 = irrelevant). */
  minLlmRelevance: 3,
  /** A claim is supported when the retrieved chunks together contain this share of its distinctive terms. */
  minUnionSupport: 0.75,
} as const;

// ───────────────────────── terms ─────────────────────────

const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does doing done for from had has have having he her him his how i if in into is it its ' +
    'me my no not of on or our out she so than that the their them then there these they this those to too up us was we were what when where which who whom why will with would you your ' +
    // question / request scaffolding that carries no topic
    'tell know explain describe define definition mean means meant find show list give gave about information info details detail learn please ' +
    'want need like get got make made use used using work works working thing things stuff kind type typically usually generally also just really very much many some any ' +
    'ask asking question questions answer answers possible able available ' +
    // discourse markers: they assert nothing about the topic
    'yes no sure certainly absolutely indeed however additionally overall unfortunately actually really'
  ).split(/\s+/),
);

/** Reduces inflections so "scholarships"/"scholarship" and "trained"/"training" meet. */
export function stem(token: string): string {
  let t = token.toLowerCase().replace(/'s$/, '');
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(ing|ed)$/.test(t) && t.length > 5) t = t.replace(/(ing|ed)$/, '');
  else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

export type Term = { raw: string; stem: string };

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9$]+(?:[.'-][a-z0-9]+)*/g) ?? [];
}

/** The question's distinctive vocabulary: no stopwords, de-duplicated by stem. */
export function contentTerms(text: string): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const raw of tokens(text)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!s || STOPWORDS.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push({ raw, stem: s });
  }
  return out;
}

/** Stems of a text, plus a 6-letter prefix key for longer stems so "automate"/"automation" still meet. */
export function stemSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const t of tokens(text)) {
    const s = stem(t);
    set.add(s);
    if (s.length >= 7) set.add(`~${s.slice(0, 6)}`);
  }
  return set;
}

const has = (hay: Set<string>, stemmed: string) => hay.has(stemmed) || (stemmed.length >= 7 && hay.has(`~${stemmed.slice(0, 6)}`));

/** Share of `terms` present in the haystack's stems. */
export function lexicalCoverage(terms: Term[], haystack: Set<string>): number {
  if (terms.length === 0) return 0;
  let hit = 0;
  for (const t of terms) if (has(haystack, t.stem)) hit++;
  return hit / terms.length;
}

export type TermProfile = {
  /** Terms that appear in no chunk at all. */
  unknown: string[];
  /** Known terms specific enough to identify the topic of a question. */
  distinctive: string[];
  /** Known but ubiquitous terms ("training", "services") that identify nothing. */
  generic: string[];
};

let totalChunks: { at: number; n: number } | undefined;
async function chunkTotal(): Promise<number> {
  if (totalChunks && Date.now() - totalChunks.at < 60_000) return totalChunks.n;
  const n = (await getQdrant().count(env.QDRANT_COLLECTION, { exact: false })).count;
  totalChunks = { at: Date.now(), n };
  return n;
}

/**
 * Document frequency of each query term across the whole knowledge base.
 *
 * A question whose distinctive vocabulary is mostly absent from the knowledge
 * base ("what is <unknown product>", "capital of France") has no possible
 * evidence, however semantically "close" an unrelated passage may be. This is
 * what separates "the KB does not contain it" from "the question is worded
 * conversationally", which a pure word-overlap rule cannot do.
 */
export async function profileTerms(terms: Term[]): Promise<TermProfile> {
  const out: TermProfile = { unknown: [], distinctive: [], generic: [] };
  const candidates = terms.filter((t) => t.raw.length >= 3 && !/^\d+$/.test(t.raw));
  if (candidates.length === 0) return out;
  const qdrant = getQdrant();
  let total = 0;
  try {
    total = await chunkTotal();
  } catch {
    return out; // cannot measure: do not use the check as a reason to refuse
  }
  await Promise.all(
    candidates.map(async (t) => {
      const variants = [...new Set([t.raw, t.stem, `${t.stem}s`, `${t.stem}e`, `${t.stem}es`, `${t.stem}ing`, `${t.stem}ed`])];
      try {
        const { count } = await qdrant.count(env.QDRANT_COLLECTION, {
          exact: false,
          filter: { should: variants.map((v) => ({ key: 'content', match: { text: v } })) } as never,
        });
        if (count === 0) out.unknown.push(t.raw);
        else if (count > total * 0.25) out.generic.push(t.raw);
        else out.distinctive.push(t.raw);
      } catch {
        // an unmeasurable term is neither evidence for nor against
      }
    }),
  );
  return out;
}

/** The question is mostly about things the knowledge base has never seen. */
export function outsideKnowledgeBase(p: TermProfile): boolean {
  return p.unknown.length > 0 && p.unknown.length >= p.distinctive.length;
}

// ───────────────────────── PostgreSQL validation ─────────────────────────

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export type Rejection = { chunkId: string; documentId: string; status: CandidateStatus; reason: string };

/**
 * Every retrieved vector must correspond to a live, public chunk in
 * PostgreSQL whose text matches what was embedded. Vectors orphaned by a
 * crash, left behind by a deletion, or embedded from an older revision of the
 * document are dropped here. The text the model sees is PostgreSQL's copy,
 * not the vector payload's.
 */
export async function validateChunks(
  sources: RetrievedSource[],
): Promise<{ valid: RetrievedSource[]; rejected: Rejection[] }> {
  if (sources.length === 0) return { valid: [], rejected: [] };

  const rows = await prisma.documentChunk.findMany({
    where: { id: { in: sources.map((s) => s.chunkId) } },
    select: {
      id: true,
      documentId: true,
      content: true,
      vectorId: true,
      headingPath: true,
      document: {
        select: { id: true, status: true, accessLevel: true, title: true, url: true, lastVerifiedAt: true, sourceId: true },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const valid: RetrievedSource[] = [];
  const rejected: Rejection[] = [];
  const reject = (s: RetrievedSource, status: CandidateStatus, reason: string) =>
    rejected.push({ chunkId: s.chunkId, documentId: s.documentId, status, reason });

  for (const s of sources) {
    const row = byId.get(s.chunkId);
    if (!row) {
      reject(s, 'rejected_not_in_postgres', 'vector has no matching chunk row (deleted or orphaned)');
      continue;
    }
    if (row.documentId !== s.documentId) {
      reject(s, 'rejected_document_mismatch', 'chunk belongs to a different document than the vector claims');
      continue;
    }
    const doc = row.document;
    if (doc.status !== DocumentStatus.INDEXED && doc.status !== DocumentStatus.EXTRACTED) {
      reject(s, 'rejected_document_state', `document is ${doc.status.toLowerCase()}`);
      continue;
    }
    if (doc.accessLevel !== 'PUBLIC') {
      reject(s, 'rejected_not_public', 'document is not public');
      continue;
    }
    if (row.vectorId && s.pointId && row.vectorId !== s.pointId) {
      reject(s, 'rejected_stale_vector', 'vector id does not match the chunk currently indexed in PostgreSQL');
      continue;
    }
    if (normalize(row.content) !== normalize(s.snippet)) {
      reject(s, 'rejected_stale_content', 'vector text differs from the current chunk text (re-indexed since)');
      continue;
    }
    valid.push({
      ...s,
      snippet: row.content,
      title: doc.title,
      url: doc.url ?? s.url,
      headingPath: row.headingPath ?? s.headingPath,
      sourceId: doc.sourceId,
      lastVerified: doc.lastVerifiedAt?.toISOString() ?? s.lastVerified,
    });
  }
  return { valid, rejected };
}

// ───────────────────────── relevance gate ─────────────────────────

export type GateResult = {
  relevant: RetrievedSource[];
  coverage: Map<string, number>;
  below: Map<string, string>;
};

/** Cheap, deterministic first gate. The LLM relevance score is applied after reranking. */
export function relevanceGate(terms: Term[], sources: RetrievedSource[]): GateResult {
  const coverage = new Map<string, number>();
  const below = new Map<string, string>();
  const relevant: RetrievedSource[] = [];

  for (const s of sources) {
    const hay = stemSet(`${s.title} ${s.headingPath ?? ''} ${s.snippet}`);
    const cov = lexicalCoverage(terms, hay);
    coverage.set(s.chunkId, cov);
    const sim = s.similarity ?? 0;
    const pass =
      cov >= THRESHOLDS.minLexicalCoverage ||
      (sim >= THRESHOLDS.semanticOverride && cov >= THRESHOLDS.semanticMinCoverage) ||
      sim >= THRESHOLDS.semanticAlone;
    if (pass) relevant.push(s);
    else below.set(s.chunkId, `covers ${Math.round(cov * 100)}% of the question's terms and similarity ${sim.toFixed(2)} is below ${THRESHOLDS.semanticOverride}`);
  }
  return { relevant, coverage, below };
}

// ───────────────────────── conversation routing ─────────────────────────

const SMALL_TALK = /^\s*(hi|hello|hey|hiya|howdy|thanks|thank you|thx|good (morning|afternoon|evening)|bye|goodbye|ok|okay|cool|great)[\s!.?,]*$/i;
export const isSmallTalk = (message: string) => SMALL_TALK.test(message);

/** A first-person request for personal help is guidance; everything else is a lookup. */
const GUIDANCE_CUES =
  /\b(i am|i'm|im|i need|i want|i'd like|i would like|help me|can you help me|for me|my (situation|resume|business|company|team|career|job)|we need|we are|we're|looking for (a )?(job|work|training))\b/i;
export function isGuidanceRequest(message: string): boolean {
  return GUIDANCE_CUES.test(message);
}

// ───────────────────────── answer verification ─────────────────────────

/** Smallest set of chunks (≤3) that together contain the claim's terms, chosen greedily. */
function coverTerms(terms: Term[], chunkStems: Set<string>[]): number[] {
  const remaining = new Set(terms.map((t) => t.stem));
  const chosen: number[] = [];
  while (remaining.size > 0 && chosen.length < 3) {
    let bestIdx = -1;
    let bestGain = 0;
    chunkStems.forEach((hay, i) => {
      if (chosen.includes(i)) return;
      let gain = 0;
      for (const t of remaining) if (has(hay, t)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    });
    if (bestIdx < 0) break;
    chosen.push(bestIdx);
    for (const t of [...remaining]) if (has(chunkStems[bestIdx]!, t)) remaining.delete(t);
  }
  return chosen;
}

export type Verification = {
  noAnswer: boolean;
  reason: string | null;
  answer: string;
  citations: Citation[];
  citationMap: TurnDiagnostics['citationMap'];
  unsupported: string[];
};

const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d[\d,]*\.\d+\b|\b\d{2,}(?:,\d{3})*\b/g;
const digitsOf = (s: string) => s.replace(/[^\d.]/g, '');

function figuresIn(text: string): string[] {
  return (text.match(FIGURE) ?? []).map(digitsOf).filter((d) => d && d !== '.');
}

/** Splits on sentence ends, keeping a citation marker that follows the full stop ("... hour. [1]") with its own sentence. */
export function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?](?:\s*\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Verifies the model's answer against the chunks it was actually given.
 *
 *  - NO_ANSWER (or an empty reply) becomes the fixed no-answer text.
 *  - Every substantive sentence must be supported by a retrieved chunk: its
 *    distinctive terms must appear there, and every figure, phone number, e-mail
 *    and URL it states must appear in the evidence verbatim.
 *  - Unsupported sentences are removed, not softened.
 *  - Citations are rebuilt from what *supports* each sentence, so a citation can
 *    only ever point at a chunk retrieved for this response, and a wrong
 *    citation the model chose is corrected rather than trusted.
 */
export function verifyAnswer(raw: string, used: RetrievedSource[]): Verification {
  const empty = (reason: string): Verification => ({
    noAnswer: true,
    reason,
    answer: NO_ANSWER_TEXT,
    citations: [],
    citationMap: [],
    unsupported: [],
  });

  const text = raw.trim();
  if (!text) return empty('model_returned_nothing');
  if (new RegExp(`\\b${NO_ANSWER_SENTINEL}\\b`).test(text) && text.length < 80) return empty('model_reported_no_answer');
  if (used.length === 0) return empty('no_sources');

  const chunkText = used.map((s) => `${s.title} ${s.headingPath ?? ''} ${s.snippet}`);
  const chunkStems = chunkText.map(stemSet);
  const evidenceFigures = new Set(figuresIn(chunkText.join(' ')));
  const evidencePhoneDigits = chunkText.join(' ').replace(/\D/g, '');
  const evidenceLower = chunkText.join('\n').toLowerCase();
  const unionStems = new Set(chunkStems.flatMap((s) => [...s]));

  const unsupported: string[] = [];
  const keptLines: { prefix: string; sentences: { text: string; chunkIdx: number[] }[] }[] = [];
  let substantive = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      keptLines.push({ prefix: '', sentences: [] });
      continue;
    }
    const prefix = line.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)?/)?.[0] ?? '';
    const body = line.slice(prefix.length);
    const kept: { text: string; chunkIdx: number[] }[] = [];

    for (const sentence of splitSentences(body)) {
      const cited = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
        .flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim())))
        .filter((n) => n >= 1 && n <= used.length)
        .map((n) => n - 1);
      const clean = sentence.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, '').replace(/\s+([.,;:!?])/g, '$1').trim();
      const terms = contentTerms(clean);
      const figs = figuresIn(clean.replace(/^\d+[.)]\s+/, ''));
      const emails = clean.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) ?? [];
      const urls = clean.match(/https?:\/\/[^\s)<>\]]+/g) ?? [];
      const phones = clean.match(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g) ?? [];

      // A lead-in such as "Here is what the sources say:" asserts nothing.
      const isClaim = !clean.endsWith(':') && (terms.length >= 2 || figs.length > 0 || emails.length > 0 || urls.length > 0);
      if (!isClaim) {
        kept.push({ text: clean, chunkIdx: [] }); // connective text carries no claim
        continue;
      }

      const figuresOk = figs.every((f) => evidenceFigures.has(f));
      const linksOk =
        emails.every((e) => evidenceLower.includes(e.toLowerCase())) &&
        urls.every((u) => evidenceLower.includes(u.replace(/[.,;)]+$/, '').toLowerCase())) &&
        phones.every((p) => evidencePhoneDigits.includes(p.replace(/\D/g, '')));

      const perChunk = chunkStems.map((hay) => lexicalCoverage(terms, hay));
      const union = lexicalCoverage(terms, unionStems);

      // Supported only when the retrieved chunks *together* contain at least 75% of the claim's
      // distinctive terms (and every figure/link verbatim). A claim that is half evidence and half
      // the model's own addition fails. The sentence cites the fewest chunks that cover it.
      let cite: number[] | null = null;
      if (figuresOk && linksOk && union >= THRESHOLDS.minUnionSupport) {
        cite = coverTerms(terms, chunkStems);
        // Keep the model's own picks when they genuinely contribute to the claim.
        for (const i of new Set(cited)) if (!cite.includes(i) && perChunk[i]! >= 0.3 && cite.length < 3) cite.push(i);
      }

      if (!cite) {
        unsupported.push(clean);
        continue;
      }
      kept.push({ text: clean, chunkIdx: cite });
      substantive++;
    }
    if (kept.length) keptLines.push({ prefix, sentences: kept });
  }

  if (substantive === 0) {
    const out = empty('no_supported_claims');
    out.unsupported = unsupported;
    return out;
  }

  // Number citations by document, in order of first use.
  const docNumber = new Map<string, number>();
  const citationMap: TurnDiagnostics['citationMap'] = [];
  const numberFor = (chunkIdx: number) => {
    const s = used[chunkIdx]!;
    let n = docNumber.get(s.documentId);
    if (!n) {
      n = docNumber.size + 1;
      docNumber.set(s.documentId, n);
      citationMap.push({ n, documentId: s.documentId, chunkIds: [], title: s.title, url: s.url });
    }
    const entry = citationMap[n - 1]!;
    if (!entry.chunkIds.includes(s.chunkId)) entry.chunkIds.push(s.chunkId);
    return n;
  };

  const rendered: string[] = [];
  for (const line of keptLines) {
    if (line.sentences.length === 0) {
      rendered.push('');
      continue;
    }
    const parts = line.sentences.map((s) => {
      const nums = [...new Set(s.chunkIdx.map(numberFor))].sort((a, b) => a - b);
      return nums.length ? `${s.text} [${nums.join(',')}]` : s.text;
    });
    rendered.push(`${line.prefix}${parts.join(' ')}`);
  }

  const citations: Citation[] = citationMap.map((c) => {
    const src = used.find((s) => s.documentId === c.documentId)!;
    return {
      id: c.n,
      title: c.title,
      url: c.url,
      lastVerified: src.lastVerified,
      documentType: src.documentType,
      documentId: c.documentId,
      chunkIds: c.chunkIds,
    };
  });

  const answer = rendered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (unsupported.length) logger.warn('Removed unsupported sentences from an answer', { count: unsupported.length, sample: unsupported[0]?.slice(0, 120) });
  return { noAnswer: false, reason: null, answer, citations, citationMap, unsupported };
}
