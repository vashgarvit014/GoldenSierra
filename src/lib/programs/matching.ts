import { RuleField } from '@prisma/client';
import type { Intent, QueryAnalysis, Recommendation, RetrievedSource, UserProfile } from '@/types/chat';
import type { ProgramRecord } from '../rag/retrieve';
import { evaluateProgram, servesCounty, type EligibilityAssessment } from './eligibility';

/**
 * Program matching.
 *
 * Produces an ordered list of services that plausibly fit what the user has
 * described. Two deliberate constraints:
 *
 *  - No match percentage is shown. We have no validated scoring model, and a
 *    number like "87% match" reads as a measurement when it would really be a
 *    guess. The internal score only decides ordering.
 *
 *  - A program is never dropped merely because we cannot confirm eligibility.
 *    It is dropped only when a verified hard rule is definitively contradicted.
 *    Everything else is surfaced with an honest "staff will confirm" caveat.
 */

export type MatchedProgram = {
  program: ProgramRecord;
  assessment: EligibilityAssessment;
  score: number;
  reasons: string[];
};

/**
 * Fields that identify membership of a specific population rather than a
 * universal precondition. County and audience are context every user has;
 * these are facts a person must volunteer about themselves.
 */
const POPULATION_FIELDS = new Set<RuleField>([
  RuleField.VETERAN_STATUS,
  RuleField.DISABILITY_STATUS,
  RuleField.AGE,
  RuleField.INCOME_LEVEL,
]);

/** Intent -> the category slugs that satisfy it. */
const INTENT_CATEGORY_FIT: Record<Intent, string[]> = {
  find_job: ['job_search', 'career_counseling', 'events'],
  find_training: ['training', 'financial_assistance'],
  financial_assistance: ['financial_assistance', 'training'],
  career_counseling: ['career_counseling', 'job_search'],
  internship: ['internships', 'training'],
  eligibility: ['financial_assistance', 'training', 'internships', 'job_search'],
  employer_hiring: ['employer_services', 'employer_incentives'],
  employer_training: ['employer_incentives', 'employer_services'],
  local_services: ['job_search', 'career_counseling', 'training', 'contact'],
  contact_referral: ['contact'],
  general_info: ['job_search', 'training', 'career_counseling', 'employer_services'],
  off_topic: [],
};

export function matchPrograms(
  programs: ProgramRecord[],
  analysis: QueryAnalysis,
  profile: UserProfile,
  sources: RetrievedSource[],
): MatchedProgram[] {
  const fitCategories = new Set(INTENT_CATEGORY_FIT[analysis.intent] ?? []);
  // Programs whose supporting documents were actually retrieved get a lift —
  // this is what keeps recommendations tied to the evidence in the answer.
  const retrievedDocumentIds = new Set(sources.map((s) => s.documentId));
  const retrievedText = sources
    .map((s) => `${s.title} ${s.snippet}`)
    .join(' ')
    .toLowerCase();

  const matched: MatchedProgram[] = [];

  for (const program of programs) {
    const assessment = evaluateProgram(program, profile);
    const reasons: string[] = [];
    let score = 0;

    // ── Hard geography check ──
    const geography = servesCounty(program, profile.county);
    if (geography === 'no') continue; // not offered where the user lives
    if (geography === 'yes') {
      score += 1.2;
      reasons.push(`Available in ${profile.county} County`);
    }

    // ── Verified hard exclusion ──
    if (!assessment.possiblyEligible) continue;

    // ── Intent / category fit ──
    if (program.category && fitCategories.has(program.category.slug)) {
      score += 2.5;
      reasons.push(`Matches what you asked about (${program.category.name.toLowerCase()})`);
    }

    // ── Audience fit ──
    if (profile.audience && (program.audience === profile.audience || program.audience === 'both')) {
      score += 1;
    } else if (profile.audience && program.audience !== profile.audience) {
      score -= 2; // an employer program for a job seeker is noise
    }

    // ── Keyword and interest overlap ──
    const haystack = `${program.name} ${program.shortDescription} ${program.keywords.join(' ')}`.toLowerCase();
    for (const keyword of analysis.keywords) {
      if (keyword.length > 3 && haystack.includes(keyword.toLowerCase())) {
        score += 0.8;
        reasons.push(`Related to "${keyword}"`);
      }
    }
    for (const interest of profile.careerInterests ?? []) {
      if (haystack.includes(interest.toLowerCase())) {
        score += 0.6;
        reasons.push(`Connected to your interest in ${interest}`);
      }
    }

    // ── Situation fit ──
    if (profile.employmentStatus === 'unemployed' || profile.employmentStatus === 'laid_off') {
      if (/job_search|training|financial_assistance|career_counseling/.test(program.category?.slug ?? '')) {
        score += 0.8;
      }
    }
    if (profile.isVeteran && program.keywords.some((k) => /veteran/i.test(k))) {
      score += 0.7;
      reasons.push('Veterans receive priority of service');
    }
    if (profile.ageBand === '18_24' && program.category?.slug === 'internships') {
      score += 0.7;
    }

    // ── Evidence grounding ──
    const linkedDocumentIds = program.documents.map((pd) => pd.documentId);
    if (linkedDocumentIds.some((id) => retrievedDocumentIds.has(id))) {
      score += 2;
      reasons.push('Described on the page that answers your question');
    } else if (retrievedText.includes(program.name.toLowerCase())) {
      score += 1;
    }

    // ── Met eligibility rules ──
    score += assessment.met.length * 0.5;

    // ── Untested population rules ──
    //
    // A program defined by membership of a specific population (veterans,
    // people with disabilities, a youth age band) should not be offered to
    // someone who never indicated they are in it. The eligibility engine is
    // right not to *exclude* them — we genuinely do not know — but surfacing
    // "Veterans Priority of Service" to someone who never mentioned service
    // is noise at best and presumptuous at worst.
    //
    // So it is a ranking penalty, not a filter: state the fact and the
    // program rises; stay silent and it stays out of the top results.
    const untestedPopulationRules = assessment.unknowns.filter(
      (rule) => rule.hard && rule.verified && POPULATION_FIELDS.has(rule.field),
    );
    score -= untestedPopulationRules.length * 3;

    if (score <= 0) continue;
    matched.push({ program, assessment, score, reasons: [...new Set(reasons)] });
  }

  matched.sort((a, b) => b.score - a.score || a.program.sortOrder - b.program.sortOrder);
  return matched;
}

/**
 * Converts matches into the UI-facing shape. Only eligibility rules with a
 * published source URL are shown, so nothing on screen implies a requirement
 * we cannot point at.
 */
export function toRecommendations(matches: MatchedProgram[], limit = 4): Recommendation[] {
  return matches.slice(0, limit).map(({ program, assessment, reasons }) => ({
    programId: program.id,
    slug: program.slug,
    name: program.name,
    shortDescription: program.shortDescription,
    whyRelevant: reasons[0] ?? 'Relevant to the services you asked about',
    eligibility: assessment.evaluations
      .filter((e) => e.verified && e.sourceUrl)
      .map((e) => ({ description: e.description, sourceUrl: e.sourceUrl, verified: e.verified })),
    nextSteps: program.nextSteps,
    officialUrl: program.officialUrl,
    contactPhone: program.contactPhone,
    requiresVerification: assessment.requiresVerification,
    exclusions: assessment.exclusions.map((e) => e.description),
    category: program.category?.name ?? null,
  }));
}
