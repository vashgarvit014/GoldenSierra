import { DocumentStatus } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import { embedQuery } from '../ai/embeddings';
import { scrollByKeywords, searchVectors, type SearchFilters, type VectorHit } from '../vector/qdrant';
import type { Intent, QueryAnalysis, RetrievedSource, UserProfile } from '@/types/chat';

/**
 * Hybrid retrieval: dense vectors for meaning, keyword matching for the exact
 * strings that embeddings handle poorly (program names, "WIOA", county names),
 * fused with Reciprocal Rank Fusion.
 *
 * RRF is used rather than a weighted score sum because the two retrievers
 * produce incomparable scores — cosine similarity against nothing at all.
 * Rank position is the only signal they share.
 */

export type RetrievalResult = {
  sources: RetrievedSource[];
  timings: { vectorMs: number; keywordMs: number; totalMs: number };
  filters: SearchFilters;
  /** How many of the vector sub-queries errored — all of them means the store was unreachable. */
  vectorQueries: number;
  vectorFailures: number;
};

/** Which document categories matter most for each intent. */
const INTENT_CATEGORIES: Record<Intent, string[]> = {
  find_job: ['job_search', 'events', 'career_counseling'],
  find_training: ['training', 'financial_assistance', 'eligibility'],
  financial_assistance: ['financial_assistance', 'training', 'eligibility'],
  career_counseling: ['career_counseling', 'events', 'job_search'],
  internship: ['internships', 'training', 'eligibility'],
  eligibility: ['eligibility', 'financial_assistance', 'training', 'internships'],
  employer_hiring: ['employer_services', 'employer_incentives'],
  employer_training: ['employer_incentives', 'employer_services', 'training'],
  local_services: ['contact', 'general', 'job_search'],
  contact_referral: ['contact', 'general'],
  general_info: ['general', 'job_search', 'employer_services'],
  off_topic: [],
};

export function buildFilters(analysis: QueryAnalysis, profile: UserProfile, sourceIds?: string[]): SearchFilters {
  const filters: SearchFilters = { accessLevels: ['PUBLIC'], language: 'en' };
  if (sourceIds?.length) filters.sourceIds = sourceIds;

  // Audience is a ranking preference, never a filter: the classifier is a
  // heuristic, and a wrong label must not hide a relevant public document
  // (see the soft boost in `retrieve`). County is a boost for the same reason.
  return filters;
}

export async function retrieve(
  analysis: QueryAnalysis,
  profile: UserProfile,
  options: {
    topK?: number; finalK?: number; sourceIds?: string[];
    /** false = search with the user's own words only */ expand?: boolean;
    /** The message exactly as typed. Searched alongside the model's rewrite, which can drift or drop words. */ originalQuery?: string;
  } = {},
): Promise<RetrievalResult> {
  const started = Date.now();
  const topK = options.topK ?? env.RETRIEVAL_TOP_K;
  const filters = buildFilters(analysis, profile, options.sourceIds);

  // Multi-part questions get one retrieval per sub-question so a two-part ask
  // ("training AND how do I apply?") does not lose half its evidence.
  const queries = buildQueries(analysis, profile, options.expand !== false, options.originalQuery);

  const vectorStart = Date.now();
  let vectorFailures = 0;
  const vectorResults = await Promise.all(
    queries.map(async (query) => {
      try {
        const vector = await embedQuery(query);
        return await searchVectors(vector, topK, filters, env.RETRIEVAL_MIN_SCORE);
      } catch (err) {
        vectorFailures++;
        logger.warn('Vector search failed for a sub-query', {
          query: query.slice(0, 80),
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as VectorHit[];
      }
    }),
  );
  const vectorMs = Date.now() - vectorStart;

  const keywordStart = Date.now();
  let keywordResults: VectorHit[] = [];
  if (analysis.keywords.length) {
    try {
      keywordResults = await scrollByKeywords(analysis.keywords, Math.ceil(topK / 2), filters);
    } catch (err) {
      logger.warn('Keyword search failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const keywordMs = Date.now() - keywordStart;

  const fused = reciprocalRankFusion([...vectorResults, keywordResults]);

  // Rank-fusion scores are relative; the raw cosine similarity is the only
  // absolute relevance signal, so keep the best one per chunk for gating/diagnostics.
  const cosine = new Map<string, number>();
  for (const list of vectorResults) {
    for (const hit of list) {
      const key = hit.payload?.chunkId ?? hit.id;
      if (key && hit.score > (cosine.get(key) ?? 0)) cosine.set(key, hit.score);
    }
  }

  // Boost passages whose category matches the intent and whose county matches
  // the user, then re-sort. Applied after fusion so it adjusts ranking rather
  // than excluding anything outright.
  const preferred = new Set(INTENT_CATEGORIES[analysis.intent] ?? []);
  const scored = fused.map((entry) => {
    const payload = entry.hit.payload;
    let boost = 1;

    // The chunk's own topic matters more than the page's, because a service
    // hub page carries one category but answers several different questions.
    if (payload.chunkCategory && preferred.has(payload.chunkCategory)) boost += 0.45;
    else if (payload.category && preferred.has(payload.category)) boost += 0.2;

    if (profile.county && payload.counties?.includes(profile.county)) boost += 0.15;

    // Audience: a mild preference. 'agency' is also what unclassifiable pages fall
    // back to, so it is treated as neutral rather than as a mismatch.
    if (profile.audience && payload.audience) {
      if (payload.audience === profile.audience || payload.audience === 'both') boost += 0.1;
      else if (payload.audience !== 'agency') boost -= 0.1;
    }

    // Prefer pages verified recently; stale material should lose ties.
    const verified = payload.lastVerifiedAt;
    if (verified && Date.now() - new Date(verified).getTime() < 1000 * 60 * 60 * 24 * 60) boost += 0.08;

    // Hero and marketing copy ("Help is here.") sits close to almost any
    // help-seeking question in embedding space while answering none of them.
    if (payload.informative === false) boost -= 0.45;

    // Board minutes, agendas and MOUs are rarely what a job seeker needs.
    if (payload.chunkCategory === 'policy' && analysis.intent !== 'general_info') boost -= 0.25;
    if (payload.documentType === 'PDF' && analysis.intent !== 'general_info') boost -= 0.1;

    return { ...entry, score: entry.score * Math.max(0.1, boost) };
  });

  scored.sort((a, b) => b.score - a.score);

  const sources: RetrievedSource[] = scored.map((entry) => ({
    chunkId: entry.hit.payload.chunkId,
    documentId: entry.hit.payload.documentId,
    pointId: String(entry.hit.id),
    similarity: cosine.get(entry.hit.payload.chunkId) ?? null,
    sourceId: entry.hit.payload.sourceId ?? null,
    title: entry.hit.payload.title,
    url: entry.hit.payload.url,
    snippet: entry.hit.payload.content,
    score: entry.score,
    headingPath: entry.hit.payload.headingPath,
    category: entry.hit.payload.category,
    lastVerified: entry.hit.payload.lastVerifiedAt,
    documentType: entry.hit.payload.documentType,
    used: false,
  }));

  return {
    sources,
    timings: { vectorMs, keywordMs, totalMs: Date.now() - started },
    filters,
    vectorQueries: queries.length,
    vectorFailures,
  };
}

/**
 * Vocabulary each intent should match, used for query expansion.
 *
 * A conversational question ("can you help me learn a new skill?") shares few
 * words with the page that answers it ("tuition assistance toward approved
 * training"). Adding the intent's own vocabulary as a second query gives the
 * dense retriever a target written in the corpus's language rather than the
 * user's.
 */
const INTENT_EXPANSIONS: Record<Intent, string> = {
  find_job: 'job openings employment listings apply for work hiring',
  find_training: 'training courses classes certification credential skills tuition assistance',
  financial_assistance: 'scholarship tuition assistance financial aid help paying for training',
  career_counseling: 'career counseling advisor guidance career planning resume help',
  internship: 'paid internship work experience earn while you learn',
  eligibility: 'eligibility requirements who qualifies priority of service',
  employer_hiring: 'employer recruit candidates post job openings screening',
  employer_training: 'on-the-job training wage reimbursement employer incentive',
  local_services: 'office location hours in person services county',
  contact_referral: 'contact phone office hours address interest form',
  general_info: 'services offered job seekers employers workforce programs',
  off_topic: '',
};

function buildQueries(analysis: QueryAnalysis, profile: UserProfile, expand = true, originalQuery?: string): string[] {
  const queries = new Set<string>();
  queries.add(analysis.rewrittenQuery);
  if (originalQuery?.trim()) queries.add(originalQuery.trim());

  // Expansion query in the corpus's vocabulary, not the user's. Skipped for
  // direct lookups, where it would pull in unrelated, generic pages.
  const expansion = expand ? INTENT_EXPANSIONS[analysis.intent] : '';
  if (expansion) {
    queries.add([expansion, ...analysis.keywords].join(' '));
  }

  if (analysis.isMultiPart) {
    for (const sub of analysis.subQuestions.slice(0, 3)) queries.add(sub);
  }

  // A context-enriched variant surfaces county- and status-specific passages
  // that the bare question would miss.
  const context = [
    profile.county ? `${profile.county} County` : null,
    profile.employmentStatus === 'unemployed' ? 'unemployed job seeker' : null,
    profile.employmentStatus === 'laid_off' ? 'laid off dislocated worker' : null,
    profile.isVeteran ? 'veteran priority of service' : null,
    profile.audience === 'employer' ? 'employer business services' : null,
  ].filter(Boolean);

  if (expand && context.length) queries.add(`${analysis.rewrittenQuery} ${context.join(' ')}`);

  return [...queries].slice(0, 4);
}

/**
 * Reciprocal Rank Fusion. k=60 is the value from the original Cormack et al.
 * paper and is the standard default; it damps the influence of top-1 results
 * enough that a single confident-but-wrong retriever cannot dominate.
 */
export function reciprocalRankFusion(
  lists: VectorHit[][],
  k = 60,
): { hit: VectorHit; score: number }[] {
  const accumulated = new Map<string, { hit: VectorHit; score: number }>();

  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = hit.payload?.chunkId ?? hit.id;
      if (!key) return;
      const contribution = 1 / (k + rank + 1);
      const existing = accumulated.get(key);
      if (existing) existing.score += contribution;
      else accumulated.set(key, { hit, score: contribution });
    });
  }

  return [...accumulated.values()].sort((a, b) => b.score - a.score);
}

/**
 * Pulls structured program facts straight from Postgres. Program status,
 * contact details and eligibility rules are authoritative records — reading
 * them from a vector match would risk answering from a stale page snapshot.
 */
export async function retrieveStructuredPrograms(
  analysis: QueryAnalysis,
  profile: UserProfile,
) {
  const audience = profile.audience;
  const categories = INTENT_CATEGORIES[analysis.intent] ?? [];

  return prisma.program.findMany({
    where: {
      status: 'ACTIVE',
      ...(audience ? { audience: { in: [audience, 'both'] } } : {}),
      ...(profile.county
        ? { OR: [{ serviceAreas: { some: { county: profile.county } } }, { serviceAreas: { none: {} } }] }
        : {}),
      ...(categories.length ? { OR: [{ category: { slug: { in: categories } } }, { category: null }] } : {}),
    },
    include: {
      category: true,
      serviceAreas: true,
      rules: true,
      documents: {
        include: { document: { select: { id: true, title: true, url: true, status: true, lastVerifiedAt: true } } },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export type ProgramRecord = Awaited<ReturnType<typeof retrieveStructuredPrograms>>[number];

/**
 * Looks up the live Document rows behind a set of retrieved chunks, so the
 * answer never cites a page that has since been archived.
 */
export async function verifySourcesAreLive(sources: RetrievedSource[]): Promise<RetrievedSource[]> {
  if (sources.length === 0) return sources;
  const documentIds = [...new Set(sources.map((s) => s.documentId))];

  const live = await prisma.document.findMany({
    where: { id: { in: documentIds }, status: { in: [DocumentStatus.INDEXED, DocumentStatus.EXTRACTED] } },
    select: { id: true, url: true, title: true, lastVerifiedAt: true },
  });

  const byId = new Map(live.map((d) => [d.id, d]));
  return sources
    .filter((source) => byId.has(source.documentId))
    .map((source) => {
      const document = byId.get(source.documentId)!;
      return {
        ...source,
        // Trust the database for display values; the vector payload is a copy.
        title: document.title,
        url: document.url ?? source.url,
        lastVerified: document.lastVerifiedAt?.toISOString() ?? source.lastVerified,
      };
    });
}
