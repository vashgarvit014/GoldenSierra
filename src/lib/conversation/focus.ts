import type { CounselorContext } from '@/types/counselor';

/**
 * The retrieval plan for a guided turn: one focused query per need the user has expressed.
 * Pure (no I/O), so question selection can ask "would this answer change what we search for?".
 */

export type Focus = {
  key: string;
  label: string;
  query: string;
  /**
   * A passage must match this (case-insensitive regex source: the town, the career field, GED wording)
   * to count for this focus — a job listing that merely shares vocabulary is a near miss, not evidence.
   */
  require?: string;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The distinctive stem of a career interest: "healthcare" → "health", "the trades" → "trade". */
function interestStem(interest: string): string | undefined {
  const word = interest.toLowerCase().split(/[^a-z]+/).find((w) => w.length >= 4 && !['work', 'jobs', 'field', 'career', 'something'].includes(w));
  if (!word) return undefined;
  const stem = word.replace(/(care|s|ing|ology|ical)$/, '');
  return escape((stem.length >= 4 ? stem : word).slice(0, 7));
}

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** One focused query per need the user has expressed — never a fixed list, never more than five. */
export function focusQueries(ctx: CounselorContext, message: string): Focus[] {
  const out: Focus[] = [];
  const pop = new Set(ctx.population);
  if (ctx.audience === 'employer') out.push({ key: 'employer', label: 'hiring help for a business', query: 'employer services help businesses hire and train employees' });
  if (ctx.careerInterest && !/still deciding|not sure|unsure|undecided/i.test(ctx.careerInterest)) {
    const stem = interestStem(ctx.careerInterest);
    out.push({ key: 'career', label: `${ctx.careerInterest} training`, query: `${ctx.careerInterest} training career pathway`, ...(stem ? { require: `\\b${stem}` } : {}) });
  }
  if (ctx.education === 'no_hs_diploma' || ctx.education === 'working_on_ged') {
    out.push({ key: 'education', label: 'finishing a GED or diploma', query: 'GED high school diploma equivalency adult education', require: String.raw`\b(ged|hiset|equivalency|adult (school|education))\b` });
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
    out.push({ key: 'location', label: `services in or near ${place}`, query: `${town} job services events workshops`, require: escape(town.toLowerCase()) });
  }
  if (out.length === 0) out.push({ key: 'request', label: 'the request', query: message.slice(0, 300) });
  return out.slice(0, 5);
}
