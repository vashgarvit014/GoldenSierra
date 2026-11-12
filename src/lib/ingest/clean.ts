import { createHash } from 'node:crypto';

/**
 * Post-extraction cleaning and classification.
 *
 * Classification is deliberately rule-based rather than model-based: these
 * labels drive hard retrieval filters, so they need to be deterministic,
 * inspectable, and free to recompute. An admin can override any of them from
 * the dashboard, and a manual override always wins over these heuristics.
 */

export function contentHash(...parts: (string | null | undefined)[]): string {
  return createHash('sha256').update(parts.filter(Boolean).join(' ')).digest('hex');
}

/**
 * Lines that recur across many pages are chrome the selector pass missed
 * (cookie banners, "Monday-Thursday 8:00am-4:30pm" in every footer). Dropping
 * them stops near-identical boilerplate from crowding out real answers.
 */
export function removeRepeatedLines(
  text: string,
  globalLineCounts: Map<string, number>,
  threshold: number,
): string {
  return text
    .split('\n')
    .filter((line) => {
      const key = line.trim().toLowerCase();
      if (key.length < 12) return true; // short lines are rarely boilerplate
      return (globalLineCounts.get(key) ?? 0) < threshold;
    })
    .join('\n');
}

export function countLines(text: string, into: Map<string, number>): void {
  for (const line of text.split('\n')) {
    const key = line.trim().toLowerCase();
    if (key.length < 12) continue;
    into.set(key, (into.get(key) ?? 0) + 1);
  }
}

export const COUNTIES = ['Placer', 'El Dorado', 'Alpine'] as const;
export type County = (typeof COUNTIES)[number];

export function detectCounties(text: string): string[] {
  const found = new Set<string>();
  const haystack = text.toLowerCase();
  if (/\bplacer\b/.test(haystack)) found.add('Placer');
  if (/\bel\s*dorado\b/.test(haystack)) found.add('El Dorado');
  if (/\balpine\b/.test(haystack)) found.add('Alpine');
  return [...found];
}

export type Audience = 'job_seeker' | 'employer' | 'both' | 'agency';

export function detectAudience(url: string | null, title: string, text: string): Audience {
  const path = (url ?? '').toLowerCase();
  if (/job-seeker|jobseeker/.test(path)) return 'job_seeker';
  if (/employer/.test(path)) return 'employer';
  if (
    /workforce-board|governing-body|public-notice|federal-funding|local-and-regional-plans|\/about|\/careers|\/sitemap|\/privacy|\/equal-opportunity/.test(
      path,
    )
  ) {
    return 'agency';
  }

  const haystack = `${title} ${text.slice(0, 2500)}`.toLowerCase();
  const jobSeekerHits = count(
    haystack,
    /\b(job seeker|resume|interview|scholarship|internship|career counsel|find a job|training)\b/g,
  );
  const employerHits = count(
    haystack,
    /\b(employer|business|hiring|recruit|on-the-job training|wage reimbursement|layoff)\b/g,
  );

  if (jobSeekerHits > employerHits * 2) return 'job_seeker';
  if (employerHits > jobSeekerHits * 2) return 'employer';
  if (jobSeekerHits + employerHits === 0) return 'agency';
  return 'both';
}

export type Category =
  | 'job_search'
  | 'training'
  | 'financial_assistance'
  | 'career_counseling'
  | 'internships'
  | 'employer_services'
  | 'employer_incentives'
  | 'eligibility'
  | 'events'
  | 'contact'
  | 'policy'
  | 'general';

export const CATEGORY_LABELS: Record<Category, string> = {
  job_search: 'Job search',
  training: 'Training & classes',
  financial_assistance: 'Financial assistance',
  career_counseling: 'Career counseling',
  internships: 'Internships & work experience',
  employer_services: 'Employer services',
  employer_incentives: 'Employer incentives',
  eligibility: 'Eligibility',
  events: 'Events & workshops',
  contact: 'Contact & referral',
  policy: 'Agency policy & governance',
  general: 'General information',
};

const CATEGORY_RULES: { category: Category; url?: RegExp; keywords: RegExp; weight?: number }[] = [
  {
    category: 'contact',
    url: /\/contact|\/account/,
    keywords: /\b(contact us|phone|email us|office hours|visit us|interest form)\b/gi,
  },
  {
    category: 'events',
    url: /\/calendar|\/hiring-events|\/event|\/workshop|\/orientation|\/career-clinic/,
    keywords: /\b(workshop|hiring event|job fair|calendar|register|rsvp|orientation|webinar)\b/gi,
  },
  {
    category: 'employer_incentives',
    url: /\/employer/,
    keywords:
      /\b(wage reimbursement|on-the-job training|ojt|hiring incentive|tax credit|get paid to hire|subsidiz)\b/gi,
    weight: 2,
  },
  {
    category: 'employer_services',
    url: /\/employer/,
    keywords:
      /\b(recruit|post your job|candidate screening|interview space|layoff assistance|rapid response|business services)\b/gi,
  },
  {
    category: 'internships',
    keywords: /\b(paid internship|internship|work experience|earn and learn|young adult)\b/gi,
    weight: 2,
  },
  {
    category: 'financial_assistance',
    keywords:
      /\b(scholarship|tuition assistance|financial aid|supportive services|stipend|gas card|childcare assistance)\b/gi,
    weight: 2,
  },
  {
    category: 'training',
    url: /\/metrix|\/training|\/elevate/,
    keywords:
      /\b(training|course|classes|certification|credential|apprenticeship|upskill|metrix)\b/gi,
  },
  {
    category: 'career_counseling',
    keywords: /\b(career counsel|career advisor|career coach|career plan|guidance|one-on-one)\b/gi,
  },
  {
    category: 'job_search',
    url: /\/jobs|\/employment-information/,
    keywords: /\b(job opening|job posting|job search|apply for a job|resume|interview|caljobs)\b/gi,
  },
  {
    category: 'eligibility',
    keywords:
      /\b(eligib|qualify|qualifications|requirements|must be|documentation required|income guidelines|priority of service)\b/gi,
    weight: 2,
  },
  {
    category: 'policy',
    url: /\/public-notices|\/workforce-board|\/governing-body|\/federal-funding|\/equal-opportunity|\/privacy|\/plans|\/document\//,
    keywords: /\b(policy|notice|agenda|minutes|bylaws|wioa|compliance|disclosure|board)\b/gi,
  },
];

/**
 * Governance paperwork: memoranda, agreements, minutes, agendas, bylaws.
 *
 * These are real agency documents but they are written in the vocabulary of
 * the services they fund, so keyword scoring reliably mislabels them — a
 * 2023 MOU was categorised `training` purely for saying "training" 80 times,
 * which put a 109-chunk contract ahead of the job seeker page. Identify them
 * by what they are, before any topical scoring runs.
 */
const GOVERNANCE_TITLE =
  /\b(mou|memorandum of understanding|agreement|minutes|agenda|bylaws?|resolution|rfp|request for proposal|local plan|regional plan|budget|audit|policy manual|attachment)\b/i;

/** Pages that describe the organisation rather than a specific service. */
const GENERAL_PATHS = /\/about$|\/about\/|\/sitemap|\/careers|^https?:\/\/[^/]+\/?$/;

/**
 * Hub pages list every service at once, so keyword scoring picks whichever
 * service happens to use the most distinctive vocabulary — the job seeker hub
 * scores as "financial_assistance" purely because "scholarship" is a
 * high-weight term. Pin them by path instead.
 */
const HUB_PATHS: [RegExp, Category][] = [
  [/\/help-for-job-seekers\/?$/, 'job_search'],
  [/\/help-for-employers\/?$/, 'employer_services'],
];

export function detectCategory(url: string | null, title: string, text: string): Category {
  const path = (url ?? '').toLowerCase();
  if (GOVERNANCE_TITLE.test(title)) return 'policy';
  if (GENERAL_PATHS.test(path)) return 'general';
  for (const [pattern, category] of HUB_PATHS) if (pattern.test(path)) return category;
  const haystack = `${title}\n${text.slice(0, 6000)}`;

  const scores = new Map<Category, number>();
  for (const rule of CATEGORY_RULES) {
    let score = count(haystack, rule.keywords) * (rule.weight ?? 1);
    if (rule.url?.test(path)) score += 6;
    if (score > 0) scores.set(rule.category, (scores.get(rule.category) ?? 0) + score);
  }

  let best: Category = 'general';
  let bestScore = 0;
  for (const [category, score] of scores) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : 'general';
}

/** Program names worth tagging, keyed by the phrases that identify them. */
const PROGRAM_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'WIOA Title I', pattern: /\bwioa\b|workforce innovation and opportunity act/i },
  { name: 'On-the-Job Training', pattern: /\bon-the-job training\b|\bOJT\b/i },
  { name: 'Metrix Learning', pattern: /\bmetrix\b/i },
  { name: 'Paid Internship', pattern: /\bpaid internship(s)?\b|\bwork experience program\b/i },
  { name: 'Training Scholarship', pattern: /\b(training )?scholarship(s)?\b|\btuition assistance\b/i },
  { name: 'Rapid Response', pattern: /\brapid response\b|\blayoff assistance\b/i },
  { name: 'Career Clinic', pattern: /\bcareer clinic\b/i },
];

export function detectProgramName(title: string, text: string): string | null {
  const haystack = `${title}\n${text.slice(0, 4000)}`;
  for (const { name, pattern } of PROGRAM_PATTERNS) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

export function detectTags(title: string, text: string): string[] {
  const haystack = `${title}\n${text.slice(0, 5000)}`.toLowerCase();
  const tags = new Set<string>();
  const checks: [string, RegExp][] = [
    ['veterans', /\bveteran/],
    ['youth', /\byoung adult|\byouth\b|\bages? 16|\b16-24\b/],
    ['disability', /\bdisabilit|\baccommodation|\bassistive technology/],
    ['low_income', /\blow[- ]income\b|\bincome[- ]eligible\b/],
    ['dislocated_worker', /\bdisplaced worker|\bdislocated worker|\blaid off\b/],
    ['english_learners', /\benglish language learner|\besl\b|\brefugee|\bimmigrant/],
    ['remote', /\bonline\b|\bvirtual\b|\bremote\b/],
    ['apprenticeship', /\bapprentice/],
  ];
  for (const [tag, pattern] of checks) if (pattern.test(haystack)) tags.add(tag);
  return [...tags];
}

function count(haystack: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = haystack.match(new RegExp(pattern.source, flags));
  return matches?.length ?? 0;
}

/**
 * Distinguishes substantive content from hero and marketing copy.
 *
 * Short, generic lines ("Help is here.", "We work for you.") embed close to
 * almost any help-seeking question while carrying no answer, so without this
 * they crowd out the specific passages that actually help someone.
 */
export function isInformative(text: string): boolean {
  const words = wordCount(text);
  if (words < 25) return false;
  if (isListing(text)) return false;

  // Content that answers something tends to carry concrete nouns, figures,
  // or service vocabulary rather than only encouragement.
  const concrete =
    /\b(eligib|apply|applica|requirement|county|training|scholarship|internship|wage|reimburse|contact|phone|hours|program|service|workshop|resume|employer|veteran|\$|\d{3}[-.)]\s?\d{3})/i.test(
      text,
    );
  return concrete || words >= 60;
}

/**
 * Detects listing/index chunks — a calendar grid, a search-results page, a
 * document library. They are mostly titles and dates with little prose, and
 * because they mention many topics at once they match almost any query while
 * answering none of them.
 */
export function isListing(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 5) return false;

  const shortLines = lines.filter((l) => wordCount(l) <= 8).length;
  const dateLines = lines.filter((l) =>
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(l),
  ).length;

  // Mostly fragments, or peppered with dates: a schedule, not an explanation.
  return shortLines / lines.length > 0.6 || dateLines >= 4;
}

/** Pages too thin to be worth an embedding (empty templates, redirect stubs). */
export function isLowValue(text: string): boolean {
  return wordCount(text) < 40;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Detects the WPML-style language prefix used on the target site (/es/, /ru/). */
export function detectLanguage(url: string | null): string {
  const match = /^https?:\/\/[^/]+\/(es|ru|fa|uk|zh|vi|tl)(\/|$)/i.exec(url ?? '');
  return match ? match[1]!.toLowerCase() : 'en';
}
