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

export function buildFilters(analysis: QueryAnalysis, profile: UserProfile): SearchFilters {
  const filters: SearchFilters = { accessLevels: ['PUBLIC'], language: 'en' };

  const audience = profile.audience;
  if (audience === 'employer') filters.audiences = ['employer', 'both'];
  else if (audience === 'job_seeker') filters.audiences = ['job_seeker', 'both'];

  if (profile.county) filters.counties = [profile.county];

  return filters;
}

export async function retrieve(
  analysis: QueryAnalysis,
  profile: UserProfile,
  options: { topK?: number; finalK?: number } = {},
): Promise<RetrievalResult> {
  const started = Date.now();
  const topK = options.topK ?? env.RETRIEVAL_TOP_K;
  const filters = buildFilters(analysis, profile);

  // Multi-part questions get one retrieval per sub-question so a two-part ask
  // ("training AND how do I apply?") does not lose half its evidence.
  const queries = buildQueries(analysis, profile);

  const vectorStart = Date.now();
  const vectorResults = await Promise.all(
    queries.map(async (query) => {
      try {
        const vector = await embedQuery(query);
        return await searchVectors(vector, topK, filters, env.RETRIEVAL_MIN_SCORE);
      } catch (err) {
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

function buildQueries(analysis: QueryAnalysis, profile: UserProfile): string[] {
  const queries = new Set<string>();
  queries.add(analysis.rewrittenQuery);

  // Expansion query in the corpus's vocabulary, not the user's.
  const expansion = INTENT_EXPANSIONS[analysis.intent];
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

  if (context.length) queries.add(`${analysis.rewrittenQuery} ${context.join(' ')}`);

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
