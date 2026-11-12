import type { Citation, ConflictNote, Recommendation, RetrievedSource } from '@/types/chat';
import { FORBIDDEN_CLAIMS } from '../ai/prompts';

/**
 * Consolidation: turning many retrieved passages into one coherent evidence
 * set, and then checking what the model did with it.
 *
 * Three jobs:
 *   1. Deduplicate overlapping passages so the same fact is not presented twice.
 *   2. Detect genuine contradictions between sources, and surface them instead
 *      of letting the model quietly pick one.
 *   3. Verify after generation that the answer stayed inside its evidence —
 *      citations resolve, no unsupported eligibility claims, no invented
 *      contact details.
 */

// ─────────────────────── Deduplication ───────────────────────

/**
 * Removes passages whose content is largely contained in a higher-ranked one.
 * Chunk overlap guarantees neighbouring chunks repeat text; without this the
 * model sees the same sentence three times and tends to restate it.
 */
export function deduplicateSources(sources: RetrievedSource[], threshold = 0.72): RetrievedSource[] {
  const kept: { source: RetrievedSource; shingles: Set<string> }[] = [];

  for (const source of sources) {
    const shingles = shingleSet(source.snippet);
    const isRedundant = kept.some(({ shingles: existing }) => {
      // Jaccard alone misses the dominant case: chunk overlap makes one
      // passage a near-subset of another, and the extra text in the longer
      // one drags symmetric similarity below any sane threshold. Containment
      // (overlap coefficient) catches that; Jaccard still catches two
      // passages that are merely similar without either containing the other.
      return (
        jaccard(shingles, existing) >= threshold || containment(shingles, existing) >= 0.85
      );
    });
    if (!isRedundant) kept.push({ source, shingles });
  }

  return kept.map((k) => k.source);
}

/** Overlap coefficient: how much of the smaller set the larger one covers. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) if (large.has(item)) intersection++;
  return intersection / small.size;
}

function shingleSet(text: string, size = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) shingles.add(words.slice(i, i + size).join(' '));
  // Very short passages produce no shingles; fall back to the whole string.
  if (shingles.size === 0 && words.length) shingles.add(words.join(' '));
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// ─────────────────────── Conflict detection ───────────────────────

/** Facts where a disagreement between pages actually misleads someone. */
const CONFLICT_PROBES: { topic: string; pattern: RegExp; normalize?: (v: string) => string }[] = [
  { topic: 'phone number', pattern: /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, normalize: (v) => v.replace(/\D/g, '') },
  { topic: 'reimbursement rate', pattern: /\b(?:up to\s*)?\d{1,3}\s?%/gi, normalize: (v) => v.replace(/\s/g, '').toLowerCase() },
  { topic: 'dollar amount', pattern: /\$\s?[\d,]+(?:\.\d{2})?/g, normalize: (v) => v.replace(/[\s,]/g, '') },
  { topic: 'age range', pattern: /\bages?\s*\d{1,2}\s*(?:-|to|through)\s*\d{1,2}\b/gi, normalize: (v) => v.toLowerCase().replace(/\s|through|to/g, '-').replace(/-+/g, '-') },
  { topic: 'office hours', pattern: /\b(?:mon|tue|wed|thu|fri)[a-z]*\s*[-–]\s*(?:mon|tue|wed|thu|fri)[a-z]*\s*,?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi, normalize: (v) => v.toLowerCase().replace(/\s/g, '') },
];

/**
 * Flags a conflict only when two sources state *different* values for the same
 * kind of fact. A page that simply omits a figure is not in conflict with one
 * that states it — absence is not disagreement.
 */
export function detectConflicts(sources: RetrievedSource[]): ConflictNote[] {
  const conflicts: ConflictNote[] = [];

  for (const probe of CONFLICT_PROBES) {
    const byValue = new Map<string, RetrievedSource[]>();

    for (const source of sources) {
      const matches = source.snippet.match(probe.pattern);
      if (!matches) continue;
      for (const match of new Set(matches)) {
        const key = probe.normalize ? probe.normalize(match) : match.toLowerCase();
        const bucket = byValue.get(key) ?? [];
        if (!bucket.some((s) => s.documentId === source.documentId)) bucket.push(source);
        byValue.set(key, bucket);
      }
    }

    // Only a real disagreement: two distinct values, each from a different page.
    const distinct = [...byValue.entries()].filter(([, srcs]) => srcs.length > 0);
    if (distinct.length < 2) continue;

    const documentIds = new Set(distinct.flatMap(([, srcs]) => srcs.map((s) => s.documentId)));
    if (documentIds.size < 2) continue;

    const involved = distinct
      .flatMap(([, srcs]) => srcs)
      .filter((s, i, arr) => arr.findIndex((o) => o.documentId === s.documentId) === i)
      .slice(0, 4);

    conflicts.push({
      topic: probe.topic,
      description:
        `Sources give different values for ${probe.topic}. ` +
        `Showing the most recently verified page; staff can confirm which is current.`,
      sources: involved.map((s) => ({ title: s.title, url: s.url, lastVerified: s.lastVerified })),
    });
  }

  return conflicts;
}

/**
 * Orders evidence so the most recently verified page wins a tie. When two
 * sources conflict, recency is the only signal we can apply honestly — we do
 * not invent a resolution.
 */
export function prioritizeByFreshness(sources: RetrievedSource[]): RetrievedSource[] {
  return [...sources].sort((a, b) => {
    const scoreDelta = (b.rerankScore ?? b.score) - (a.rerankScore ?? a.score);
    // Only let recency break near-ties; it must not override relevance.
    if (Math.abs(scoreDelta) > 0.08) return scoreDelta;
    const aTime = a.lastVerified ? new Date(a.lastVerified).getTime() : 0;
    const bTime = b.lastVerified ? new Date(b.lastVerified).getTime() : 0;
    return bTime - aTime;
  });
}

// ─────────────────────── Citations ───────────────────────

export function buildCitations(sources: RetrievedSource[]): Citation[] {
  // One citation per document, numbered to match the SOURCES block order.
  const seen = new Map<string, Citation>();
  sources.forEach((source, i) => {
    if (seen.has(source.documentId)) return;
    seen.set(source.documentId, {
      id: i + 1,
      title: source.title,
      url: source.url,
      lastVerified: source.lastVerified,
      documentType: source.documentType,
    });
  });
  return [...seen.values()];
}

/** Citation markers the model actually used, e.g. [1] and [2,3]. */
export function extractCitedIds(answer: string): number[] {
  const ids = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const id = Number(part.trim());
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Drops citation markers that point at a source that was not supplied, and
 * renumbers the rest so the visible list matches the text. A dangling [7] is
 * worse than no marker at all — it implies evidence that does not exist.
 */
export function reconcileCitations(
  answer: string,
  sources: RetrievedSource[],
): { answer: string; citations: Citation[] } {
  const cited = extractCitedIds(answer);
  const valid = cited.filter((id) => id >= 1 && id <= sources.length);

  if (valid.length === 0) {
    // No usable markers: still show the evidence that informed the answer.
    return { answer: stripCitations(answer), citations: buildCitations(sources.slice(0, 4)) };
  }

  const renumber = new Map<number, number>();
  valid.forEach((oldId, i) => renumber.set(oldId, i + 1));

  const rewritten = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (whole, group: string) => {
    const mapped = group
      .split(',')
      .map((part) => renumber.get(Number(part.trim())))
      .filter((n): n is number => n !== undefined);
    return mapped.length ? `[${[...new Set(mapped)].join(',')}]` : '';
  });

  const citations: Citation[] = valid.map((oldId, i) => {
    const source = sources[oldId - 1]!;
    return {
      id: i + 1,
      title: source.title,
      url: source.url,
      lastVerified: source.lastVerified,
      documentType: source.documentType,
    };
  });

  return { answer: rewritten.replace(/\s+([.,;])/g, '$1').trim(), citations };
}

function stripCitations(answer: string): string {
  return answer.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1');
}

// ─────────────────────── Grounding checks ───────────────────────

export type GroundingReport = {
  grounded: boolean;
  issues: string[];
  /** Claims we can point at but could not match to any source. */
  unsupportedClaims: string[];
};

/**
 * Post-generation safety net. Catches the failures that matter most to a
 * person acting on this answer: a stated eligibility decision, a phone number
 * or URL that appears nowhere in the evidence, or an answer with no evidence
 * behind it at all.
 */
export function checkGrounding(
  answer: string,
  sources: RetrievedSource[],
  /**
   * Verified program records also shown to the model. Without these the check
   * flags the agency's own published phone number as a fabrication whenever it
   * reached the model through a Program row rather than a retrieved passage —
   * marking a correct answer as ungrounded, which is worse than not checking.
   */
  programs: Recommendation[] = [],
): GroundingReport {
  const issues: string[] = [];
  const unsupportedClaims: string[] = [];

  const programEvidence = programs
    .map((p) =>
      [p.name, p.shortDescription, p.nextSteps, p.officialUrl, p.contactPhone]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n');

  const evidence = [...sources.map((s) => `${s.title} ${s.snippet}`), programEvidence]
    .join('\n')
    .toLowerCase();

  const lower = answer.toLowerCase();
  for (const phrase of FORBIDDEN_CLAIMS) {
    if (lower.includes(phrase)) {
      issues.push(`Asserted an eligibility decision: "${phrase}"`);
      unsupportedClaims.push(phrase);
    }
  }

  // Contact details are the highest-consequence thing to hallucinate.
  for (const phone of answer.match(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g) ?? []) {
    const digits = phone.replace(/\D/g, '');
    if (!evidence.replace(/\D/g, '').includes(digits)) {
      issues.push(`Phone number not present in any source: ${phone}`);
      unsupportedClaims.push(phone);
    }
  }

  for (const email of answer.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) ?? []) {
    if (!evidence.includes(email.toLowerCase())) {
      issues.push(`Email address not present in any source: ${email}`);
      unsupportedClaims.push(email);
    }
  }

  for (const url of answer.match(/https?:\/\/[^\s)<>\]]+/g) ?? []) {
    const cleaned = url.replace(/[.,;)]+$/, '').toLowerCase();
    const inSources =
      sources.some((s) => s.url && cleaned.startsWith(s.url.toLowerCase().slice(0, 40))) ||
      programs.some((p) => p.officialUrl && cleaned.startsWith(p.officialUrl.toLowerCase().slice(0, 40)));
    if (!inSources && !evidence.includes(cleaned) && !cleaned.includes('goldensierra.com')) {
      issues.push(`Link not present in any source: ${cleaned}`);
      unsupportedClaims.push(cleaned);
    }
  }

  if (sources.length === 0 && answer.length > 400) {
    issues.push('Long answer produced with no supporting sources');
  }

  return { grounded: issues.length === 0, issues, unsupportedClaims };
}

/**
 * Rewrites the phrasings that overstate certainty. Applied as a last pass so a
 * model slip never reaches the user as an eligibility decision.
 */
export function softenOverclaims(answer: string): string {
  const substitutions: [RegExp, string][] = [
    [/\byou are eligible\b/gi, 'you may be eligible'],
    [/\byou're eligible\b/gi, "you may be eligible"],
    [/\byou qualify\b/gi, 'you may qualify'],
    [/\byou will receive\b/gi, 'you may be able to receive'],
    [/\byou will get\b/gi, 'you may be able to get'],
    [/\bguaranteed\b/gi, 'possible'],
    [/\byou have been approved\b/gi, 'staff can review your situation'],
  ];

  let out = answer;
  for (const [pattern, replacement] of substitutions) {
    out = out.replace(pattern, (matched) => matchCase(matched, replacement));
  }
  return out;
}

/**
 * Preserves the capitalisation of the text being replaced. Without this a
 * substitution at the start of a sentence leaves it beginning in lower case,
 * which reads as a typo in an answer people are meant to trust.
 */
function matchCase(original: string, replacement: string): string {
  const firstLetter = original.match(/[a-z]/i)?.[0];
  if (!firstLetter || firstLetter !== firstLetter.toUpperCase()) return replacement;
  return replacement.charAt(0).toUpperCase() + replacement.slice(1);
}
