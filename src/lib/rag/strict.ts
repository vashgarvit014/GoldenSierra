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

export const NO_ANSWER_TEXT = "I couldn't find enough information about that in the currently indexed knowledge base.";
export const KB_UNAVAILABLE_TEXT =
  "I can't reach the knowledge base right now, so I can't answer that. Please try again in a moment.";
/** The model produced nothing usable (even after the bounded retry). Not a claim about the index. */
export const GENERATION_FAILED_TEXT =
  "I found indexed material that may be relevant, but I couldn't produce a verified answer just now. Please try asking again.";
export const SMALL_TALK_TEXT = "Hello! Ask me a question and I'll answer it from the indexed knowledge base.";
/** What the model must output, verbatim, when the sources do not answer the question. */
export const NO_ANSWER_SENTINEL = 'NO_ANSWER';

export const THRESHOLDS = {
  /** Share of the question's distinctive terms a passage must contain to count as relevant on its own. */
  minLexicalCoverage: 0.5,
  /** A semantically close passage may pass with a little term overlap… */
  // Calibrated on the live index (scripts/calibrate-relevance.ts, 21 answerable / 18 unanswerable queries,
  // and tests/e2e/strict-stability.ts repeat runs): with concept-aware, figure-free coverage the sweep is flat from
  // 0.56 to 0.64 (identical recall, identical leakage), but repeat runs showed a supported paraphrase whose
  // chunk scores 0.61 refusing intermittently at 0.62. 0.60 sits inside the flat region, with margin, and
  // below it unrelated passages begin to appear.
  semanticOverride: 0.6,
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

/**
 * Words that mean the same thing for the purpose of "does this passage speak to the
 * question". Deliberately small and conservative: true synonyms only, never merely
 * related words (phone ≠ email, cost ≠ free). Used for relevance and paraphrase
 * matching; figures, links and phone numbers are still compared verbatim.
 */
const CONCEPT_GROUPS: string[][] = [
  ['contact', 'touch', 'reach'],
  ['phone', 'telephone', 'call', 'dial'],
  ['email', 'e-mail'],
  ['eligible', 'eligibility', 'qualify', 'qualification', 'qualified', 'entitled'],
  ['cost', 'price', 'fee', 'charge'],
  ['free', 'no-cost', 'complimentary', 'gratis'],
  ['hire', 'recruit', 'recruiting', 'recruitment'],
  ['wage', 'salary', 'pay', 'earn', 'compensation'],
  ['help', 'assist', 'assistance', 'support', 'aid'],
  ['offer', 'provide'],
  ['require', 'requirement', 'must', 'necessary', 'mandatory'],
  ['begin', 'start', 'commence'],
  ['end', 'finish', 'conclude', 'complete'],
  ['address', 'location', 'located'],
  ['job', 'employment', 'position', 'opening'],
  ['course', 'class'],
  ['internship', 'intern'],
  ['apply', 'application', 'enroll', 'register', 'registration', 'sign-up'],
  ['employer', 'business', 'company'],
  ['veteran', 'veterans'],
];
const CONCEPT_OF = new Map<string, number>();
CONCEPT_GROUPS.forEach((group, i) => group.forEach((w) => CONCEPT_OF.set(stem(w), i)));

/** Stems of a text, plus a 6-letter prefix key for longer stems so "automate"/"automation" still meet, plus its concept keys. */
export function stemSet(text: string): Set<string> {
  const set = new Set<string>();
  const add = (word: string) => {
    const s = stem(word);
    if (!s) return;
    set.add(s);
    if (s.length >= 7) set.add(`~${s.slice(0, 6)}`);
    const c = CONCEPT_OF.get(s);
    if (c !== undefined) set.add(`@${c}`);
  };
  for (const raw of text.match(/[A-Za-z0-9$]+(?:[.'-][A-Za-z0-9]+)*/g) ?? []) {
    add(raw.toLowerCase());
    // Scraped pages glue words together ("Office115", "7722Fax", "OurTeam"). Index the parts as well,
    // in addition to the whole token, so a question's "office" still meets "Office115".
    const parts = raw.split(/(?<=[a-z])(?=[A-Z0-9])|(?<=[0-9])(?=[A-Za-z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) for (const part of parts) if (part.length >= 2) add(part.toLowerCase());
  }
  return set;
}

const has = (hay: Set<string>, stemmed: string) => {
  if (hay.has(stemmed) || (stemmed.length >= 7 && hay.has(`~${stemmed.slice(0, 6)}`))) return true;
  const c = CONCEPT_OF.get(stemmed);
  return c !== undefined && hay.has(`@${c}`);
};

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

/**
 * Unknown terms the user wrote as a proper noun ("minimum wage in Oregon", "CalFresh"): a named
 * thing the knowledge base has never mentioned. The question is about it, so unrelated passages
 * that merely share the generic words cannot answer it. Ignored for sentence-initial words and
 * for questions written in Title Case.
 */
export function namedUnknowns(message: string, unknown: string[]): string[] {
  const words = message.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (words.length === 0) return [];
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (words.length > 3 && capitalised / words.length > 0.5) return []; // Title Case / shouting
  const wanted = new Set(unknown.map((u) => u.toLowerCase()));
  return words.filter((w, i) => i > 0 && /^[A-Z]/.test(w) && wanted.has(w.toLowerCase()));
}

/** The question is mostly about things the knowledge base has never seen. */
export function outsideKnowledgeBase(p: TermProfile, named: string[] = []): boolean {
  return p.unknown.length > 0 && (named.length > 0 || p.unknown.length >= p.distinctive.length);
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

/**
 * The terms that say what a question is *about*. Figures ("$40,000") are checked against the
 * evidence at answer time, and ubiquitous words ("year", "training") match nearly every passage,
 * so counting either against a passage's coverage only dilutes it and refuses answerable questions.
 */
export function topicalTerms(terms: Term[], profile?: TermProfile): Term[] {
  const noFigures = terms.filter((t) => !/^\$?\d/.test(t.raw));
  const generic = new Set(profile?.generic ?? []);
  const topical = noFigures.filter((t) => !generic.has(t.raw));
  return topical.length > 0 ? topical : noFigures.length > 0 ? noFigures : terms;
}

/** The page's own domain with the dots removed ("goldensierracom"): what a term naming the site can be matched against. */
export function hostKey(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '').replace(/\./g, '');
  } catch {
    return '';
  }
}

/**
 * Coverage of `terms` by a passage, where a term naming the passage's own site ("Golden Sierra" on
 * goldensierra.com) also counts as covered. The site name only supplements real overlap: a passage
 * that shares none of the question's words with it is not relevant because of its domain.
 */
function coverageWithSite(terms: Term[], hay: Set<string>, host: string): number {
  if (terms.length === 0) return 0;
  let content = 0;
  let site = 0;
  for (const t of terms) {
    if (has(hay, t.stem)) content++;
    else if (t.raw.length >= 5 && host.includes(t.raw)) site++;
  }
  return content === 0 ? 0 : (content + site) / terms.length;
}

/**
 * Cheap, deterministic first gate. The LLM relevance score is applied after reranking.
 *
 * A passage's coverage is the better of two measures — every non-figure term, and the topical
 * terms alone — so ignoring ubiquitous words can only ever admit more answerable passages,
 * never fewer than counting them would.
 */
export function relevanceGate(terms: Term[], sources: RetrievedSource[], profile?: TermProfile): GateResult {
  const coverage = new Map<string, number>();
  const below = new Map<string, string>();
  const relevant: RetrievedSource[] = [];
  const everyTerm = terms.filter((t) => !/^\$?\d/.test(t.raw));
  const topical = topicalTerms(terms, profile);

  for (const s of sources) {
    const hay = stemSet(`${s.title} ${s.headingPath ?? ''} ${s.snippet}`);
    const host = hostKey(s.url);
    const cov = Math.max(coverageWithSite(everyTerm.length ? everyTerm : terms, hay, host), coverageWithSite(topical, hay, host));
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

// ───────────────────────── figures ─────────────────────────

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "four" → 4, "twenty-five" → 25, "50 percent" → 50%, "1,000 dollars" → $1,000. "one" only counts on the evidence side (it is also a pronoun). */
function normalizeNumbers(text: string, evidenceSide: boolean): string {
  const tens = Object.keys(TENS).join('|');
  const units = Object.keys(UNITS).filter((w) => UNITS[w]! < 10).join('|');
  const small = Object.keys(UNITS).filter((w) => evidenceSide || w !== 'one').join('|');
  return text
    .replace(new RegExp(`\\b(${tens})[-\\s](${units})\\b`, 'gi'), (_, t: string, u: string) => String(TENS[t.toLowerCase()]! + UNITS[u.toLowerCase()]!))
    .replace(new RegExp(`\\b(${tens})\\b`, 'gi'), (_, t: string) => String(TENS[t.toLowerCase()]))
    .replace(new RegExp(`\\b(${small})\\b`, 'gi'), (_, w: string) => String(UNITS[w.toLowerCase()]))
    .replace(/(\d)\s*(?:percent|per cent)\b/gi, '$1%')
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|usd)\b/gi, '$$$1');
}

// Boundaries only guard against neighbouring digits: scraped text is often glued ("California115 Ascot", "7722Fax").
const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|(?<!\d)\d[\d,]*(?:\.\d+)?\s?%|(?<![\d$])\d[\d,]*(?:\.\d+)?(?!\d)/g;

/** Canonical numeric text, so 15.50 = 15.5 and 1,000 = 1000. */
function canonNumber(raw: string): string {
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? String(n) : raw;
}

export type Qualifier = 'none' | 'cap' | 'floor' | 'approx';
export type Figure = { key: string; plain: string; qualifier: Qualifier };

const CAP = /\b(?:up to|as much as|as many as|maximum(?: of)?|max|no more than|at most|capped at)\s*$/i;
const FLOOR = /\b(?:at least|minimum(?: of)?|min|starting at|starts at|as low as|no less than|more than|over)\s*$/i;
const APPROX = /(?:\b(?:about|around|approximately|roughly|estimated|nearly|almost)|~)\s*$/i;

/** Every figure in a text, with its unit, and whether the text qualifies it ("up to", "at least", "about"). */
export function figuresIn(text: string, evidenceSide = false): Figure[] {
  const t = normalizeNumbers(text.replace(/^\s*\d+[.)]\s+/, ''), evidenceSide);
  const out: Figure[] = [];
  for (const m of t.matchAll(FIGURE)) {
    const raw = m[0];
    const plain = canonNumber(raw);
    if (!plain || plain === '.') continue;
    const unit = raw.startsWith('$') ? '$' : raw.endsWith('%') ? '%' : '';
    const before = t.slice(Math.max(0, m.index! - 24), m.index!);
    const qualifier: Qualifier = CAP.test(before) ? 'cap' : FLOOR.test(before) ? 'floor' : APPROX.test(before) ? 'approx' : 'none';
    out.push({ key: `${unit}${plain}`, plain, qualifier });
  }
  return out;
}

const EXACTNESS = /\b(?:exact|exactly|precisely|flat|fixed|guaranteed|always)\b/i;

/**
 * A claimed figure is supported when the evidence states the same figure (with the same
 * unit), and the claim does not make it firmer than the source does: "$1,000" is not
 * supported by "up to $1,000", and "up to" is not supported by "at least".
 */
export function figureSupported(claim: Figure, sentence: string, evidence: Figure[]): boolean {
  const same = evidence.filter((e) => (claim.key.startsWith('$') || claim.key.endsWith('%') ? e.key === claim.key : e.plain === claim.plain));
  if (same.length === 0) return false;
  const quals = new Set(same.map((e) => e.qualifier));
  if (claim.qualifier === 'none') return quals.has('none') && !(EXACTNESS.test(sentence) && !quals.has('none'));
  if (claim.qualifier === 'approx') return true; // a hedge is never stronger than the source
  return quals.has(claim.qualifier) || quals.has('none');
}

/** Splits on sentence ends, keeping a citation marker that follows the full stop ("... hour. [1]") with its own sentence. */
/** Sentence openers that refer back to the previous sentence. */
const ANAPHORIC_START = /^(all|both|each|they|these|those|it|this|that|its|their|such|the latter|the former|also|additionally|in addition)\b/i;
/** CJK, Cyrillic, Arabic, Hebrew, Thai… — anything an English answer should not contain. */
const NON_LATIN = /[\u0400-\u04ff\u0590-\u06ff\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

export function splitSentences(line: string): string[] {
  return line
    // Never after an initial or a common abbreviation ("S. Lake Tahoe", "Ste. 300", "St. Mary's").
    .split(/(?<=[.!?](?:\s*\[\d+(?:\s*,\s*\d+)*\])*)(?<!(?:^|[\s(])[A-Z]\.)(?<!\b(?:Ste|St|Mt|Dr|Mr|Mrs|Ms|Jr|Sr|Inc|Ave|Blvd|Hwy|No|vs|approx|e\.g|i\.e)\.)\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ───────────────────────── gaps in the documents ─────────────────────────

const GAP_VERB = '(?:state|specify|mention|list|define|provide|say|give|indicate|contain|include|describe|publish|address|identify|show|cover|have|set|note)';
const GAP_SUBJECT = '(?:(?:the|these|those|our)\\s+)?(?:sources?|documents?|pages?|passages?|materials?|information|text|indexed\\s+\\w+|knowledge base|they)';
const GAP_CLAUSE = new RegExp(
  `(?:^|[,;:\u2014\u2013]\\s*|\\s+)(?:(?:but|however|yet|although|though|and|so|therefore)\\s*,?\\s+)?${GAP_SUBJECT}\\s+(?:(?:do(?:es)?|did)\\s+not|don['\u2019]t|doesn['\u2019]t|(?:contain|provide|give|have)\\s+no|never)\\s+(?:\\w+\\s+){0,2}?${GAP_VERB}\\b[^]*$`,
  'i',
);

/**
 * Splits "X is available only to A or B, but the sources do not specify an income threshold" into the
 * claim ("X is available only to A or B") and the statement about the documents' silence. The claim is
 * verified like any other; the silence note says nothing about the world and is kept only if it adds no
 * new facts (see verifyAnswer).
 */
export function peelGap(sentence: string): { claim: string; gap: string | null } {
  const m = GAP_CLAUSE.exec(sentence);
  if (!m) return { claim: sentence, gap: null };
  const connective = /^(?:but|however|yet|although|though|and|so|therefore)\s*,?\s+/i;
  let claim = sentence.slice(0, m.index).replace(/[\s,;:\u2014\u2013]+$/, '').replace(/\s+(?:but|however|yet|although|though|and|so|therefore)$/i, '').trim();
  let gap = sentence.slice(m.index).replace(/^[\s,;:\u2014\u2013]+/, '').replace(connective, '').trim();
  gap = gap.charAt(0).toUpperCase() + gap.slice(1);
  if (claim && !/[.!?]$/.test(claim)) claim += '.';
  return { claim, gap };
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
export function verifyAnswer(raw: string, used: RetrievedSource[], context: { question?: string } = {}): Verification {
  const empty = (reason: string): Verification => ({
    noAnswer: true,
    reason,
    // An empty generation says nothing about the index, so it must not read as "nothing indexed".
    answer: reason === 'model_returned_nothing' && used.length > 0 ? GENERATION_FAILED_TEXT : NO_ANSWER_TEXT,
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
  const evidenceFigures = figuresIn(chunkText.join(' \n '), true);
  const questionFigures = new Set(figuresIn(context.question ?? '').map((f) => f.plain));
  const evidencePhoneDigits = chunkText.join(' ').replace(/\D/g, '');
  const evidenceLower = chunkText.join('\n').toLowerCase();
  const unionStems = new Set(chunkStems.flatMap((s) => [...s]));
  // "For Golden Sierra, call…" names the site the page came from. The page's own domain is evidence of that attribution.
  const hosts = used.map((s) => hostKey(s.url)).filter(Boolean);
  const isAttribution = (t: Term) => t.raw.length >= 5 && hosts.some((h) => h.includes(t.raw));

  const unsupported: string[] = [];
  const keptLines: { prefix: string; sentences: { text: string; chunkIdx: number[] }[] }[] = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      keptLines.push({ prefix: '', sentences: [] });
      continue;
    }
    const prefix = line.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)?/)?.[0] ?? '';
    const body = line.slice(prefix.length);
    const kept: { text: string; chunkIdx: number[] }[] = [];
    const isListItem = /^\s*(?:[-*•]|\d+[.)])\s+/.test(prefix);
    let headRemoved = false;
    let sentenceIndex = -1;

    const units: { sentence: string; gap: boolean; cited: number[] }[] = [];
    for (const sentence of splitSentences(body)) {
      const cited = [...sentence.matchAll(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*,?\s*\]/g)]
        .flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim())))
        .filter((n) => n >= 1 && n <= used.length)
        .map((n) => n - 1);
      // "…listed in source [1] …" loses its marker here (citations are re-attached at the sentence end),
      // so the words that pointed at it go too — never "in source  lists".
      const whole = sentence
        .replace(/\s*\b(?:(?:as )?(?:listed |shown |described |stated )?(?:in|from|according to|per|see)\s+)?(?:the\s+)?sources?\s*(?=\[\s*\d)/gi, ' ')
        .replace(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*,?\s*\]/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;:!?])/g, '$1')
        .trim();
      const { claim, gap } = peelGap(whole);
      if (claim) units.push({ sentence: claim, gap: false, cited });
      if (gap) units.push({ sentence: gap, gap: true, cited: [] });
    }

    let previousRemoved = false;
    for (const unit of units) {
      sentenceIndex++;
      const { cited } = unit;
      const clean = unit.sentence;
      // "All are located at…" / "They pay…" only make sense after the sentence they refer back to.
      // When that sentence was removed as unsupported, its follow-on goes too rather than dangle.
      if (previousRemoved && ANAPHORIC_START.test(clean)) {
        unsupported.push(clean);
        continue;
      }
      // Answers must be in English; a sentence in another script cannot be checked against the sources.
      if (NON_LATIN.test(clean)) {
        unsupported.push(clean);
        previousRemoved = true;
        continue;
      }
      previousRemoved = false;

      // A statement about what the documents do not say asserts nothing about the world. It may repeat the
      // user's own figures ("…whether $40,000 qualifies") but may not introduce any figure or link of its own.
      if (unit.gap) {
        const fresh = figuresIn(clean).filter((f) => !questionFigures.has(f.plain) && !figureSupported(f, clean, evidenceFigures));
        if (fresh.length === 0 && !/https?:\/\/|@/.test(clean)) kept.push({ text: clean, chunkIdx: [] });
        else unsupported.push(clean);
        continue;
      }
      const terms = contentTerms(clean);
      const figs = figuresIn(clean);
      const emails = clean.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) ?? [];
      const urls = clean.match(/https?:\/\/[^\s)<>\]]+/g) ?? [];
      const phones = clean.match(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g) ?? [];

      // A lead-in such as "Here is what the sources say:" asserts nothing.
      const isClaim = !clean.endsWith(':') && (terms.length >= 2 || figs.length > 0 || emails.length > 0 || urls.length > 0);
      if (!isClaim) {
        kept.push({ text: clean, chunkIdx: [] }); // connective text carries no claim
        continue;
      }

      const figuresOk = figs.every((f) => figureSupported(f, clean, evidenceFigures));
      const linksOk =
        emails.every((e) => evidenceLower.includes(e.toLowerCase())) &&
        urls.every((u) => evidenceLower.includes(u.replace(/[.,;)]+$/, '').toLowerCase())) &&
        phones.every((p) => evidencePhoneDigits.includes(p.replace(/\D/g, '')));

      const content = terms.filter((t) => !isAttribution(t));
      const scored = content.length > 0 ? content : terms;
      const perChunk = chunkStems.map((hay) => lexicalCoverage(scored, hay));
      const union = lexicalCoverage(scored, unionStems);

      // Supported only when the retrieved chunks *together* contain at least 75% of the claim's
      // distinctive terms (and every figure/link verbatim). A claim that is half evidence and half
      // the model's own addition fails. The sentence cites the fewest chunks that cover it.
      let cite: number[] | null = null;
      if (figuresOk && linksOk && union >= THRESHOLDS.minUnionSupport) {
        cite = coverTerms(scored, chunkStems);
        // Keep the model's own picks when they genuinely contribute to the claim.
        for (const i of new Set(cited)) if (!cite.includes(i) && perChunk[i]! >= 0.3 && cite.length < 3) cite.push(i);
      }

      if (!cite) {
        unsupported.push(clean);
        previousRemoved = true;
        if (isListItem && sentenceIndex === 0) headRemoved = true;
        continue;
      }
      kept.push({ text: clean, chunkIdx: cite });
    }
    // A list item's first sentence names what the rest of the item is about; without it the remainder is an orphan.
    if (headRemoved) continue;
    if (kept.length) keptLines.push({ prefix, sentences: kept });
  }

  // A lead-in ("Two options fit:") with nothing after it to introduce is removed.
  for (let i = keptLines.length - 1; i >= 0; i--) {
    const line = keptLines[i]!;
    const leadIn = line.sentences.length > 0 && line.sentences.every((x) => x.chunkIdx.length === 0) && /:\s*$/.test(line.sentences.at(-1)!.text);
    if (!leadIn) continue;
    const next = keptLines.slice(i + 1).find((l) => l.sentences.length > 0);
    if (!next || !/^\s*(?:[-*•]|\d+[.)])\s+/.test(next.prefix)) keptLines.splice(i, 1);
  }

  const substantive = keptLines.reduce((n, l) => n + l.sentences.filter((x) => x.chunkIdx.length > 0).length, 0);
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
