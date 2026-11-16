import type {
  CounselorContext,
  ProgramMatch,
  QuickReply,
  SessionMode,
} from '@/types/counselor';
import { SUBJECT } from '@/types/counselor';

/**
 * Adaptive next-question selection.
 *
 * This is the behaviour the brief cares most about, so it is deterministic
 * rather than left to the model: the LLM writes the sentence, but *which*
 * question gets asked is decided here, from evidence.
 *
 * The rule is information gain. For each unanswered question we compute how
 * much knowing the answer would actually narrow the live candidate set. A
 * question that cannot change the outcome — because every remaining program
 * treats the answer identically — is skipped, however standard it looks. That
 * is what stops the assistant marching every user through the same script.
 */

export type QuestionId =
  | 'audience'
  | 'county'
  | 'age'
  | 'education'
  | 'careerInterest'
  | 'employmentStatus'
  | 'transportation'
  | 'incomeUrgency'
  | 'population';

export type Question = {
  id: QuestionId;
  /** Context field it fills; used to detect "already answered". */
  field: keyof CounselorContext;
  /** Written per mode so helper mode says "they", not "you". */
  prompt: (mode: SessionMode, ctx: CounselorContext) => string;
  quickReplies: (mode: SessionMode) => QuickReply[];
  /**
   * How a candidate program would be partitioned by each possible answer.
   * Returning the same bucket for every program means zero information gain.
   */
  partition: (match: ProgramMatch) => string;
  /** Baseline weight when candidate partitioning is uninformative. */
  baseValue: number;
  /** Never ask unless this holds. */
  applicable?: (ctx: CounselorContext) => boolean;
};

const s = (mode: SessionMode) => SUBJECT[mode];

export const QUESTIONS: Question[] = [
  {
    id: 'audience',
    field: 'audience',
    baseValue: 0.9,
    // In helper mode the user is supporting a person, so the job-seeker side
    // is already implied — asking "are you looking for work yourself" there
    // just confuses them. Only ask when it is genuinely ambiguous.
    applicable: (ctx) => ctx.mode === 'self',
    prompt: () =>
      'Quick check so I point you the right way — are you looking for work yourself, or hiring for a business?',
    quickReplies: () => [
      { label: 'Looking for work', value: 'I am looking for work' },
      { label: "I'm an employer", value: 'I am an employer looking to hire' },
    ],
    partition: (m) => (m.category ?? 'none'),
  },
  {
    id: 'county',
    field: 'county',
    baseValue: 0.85,
    prompt: (mode) =>
      `Which county ${s(mode).pronoun === 'you' ? 'are you' : 'are they'} in? It decides which offices and providers are reachable.`,
    quickReplies: () => [
      { label: 'Placer', value: 'Placer County' },
      { label: 'El Dorado', value: 'El Dorado County' },
      { label: 'Alpine', value: 'Alpine County' },
      { label: 'Not sure', value: "I'm not sure which county" },
    ],
    // Programs differ by service area, so county genuinely splits the set.
    partition: (m) => m.counties.slice().sort().join(',') || 'any',
  },
  {
    id: 'careerInterest',
    field: 'careerInterest',
    baseValue: 0.7,
    prompt: (mode) =>
      `What kind of work ${s(mode).pronoun === 'you' ? 'are you' : 'are they'} aiming for? Even a rough direction helps.`,
    quickReplies: () => [
      { label: 'Healthcare', value: 'Interested in healthcare' },
      { label: 'Trades / construction', value: 'Interested in the trades or construction' },
      { label: 'Office / admin', value: 'Interested in office or administrative work' },
      { label: 'Still deciding', value: 'Still deciding what kind of work' },
    ],
    partition: (m) => m.category ?? 'none',
  },
  {
    id: 'education',
    field: 'education',
    baseValue: 0.65,
    prompt: (mode) =>
      `Where ${s(mode).pronoun === 'you' ? 'are you' : 'are they'} up to with a high school diploma or GED? Some training needs it first, some doesn't.`,
    quickReplies: () => [
      { label: 'GED / diploma done', value: 'GED or high school diploma completed' },
      { label: 'Still working on it', value: 'Still working on the GED' },
      { label: 'Not started', value: 'No high school diploma or GED yet' },
      { label: 'Some college', value: 'Has some college' },
    ],
    partition: (m) => (/training|scholarship|internship/i.test(m.slug) ? 'education_sensitive' : 'other'),
  },
  {
    id: 'transportation',
    field: 'transportation',
    baseValue: 0.6,
    prompt: (mode, ctx) => {
      const where = ctx.city ?? ctx.county ?? 'the area';
      return `One thing that changes the options a lot — can ${s(mode).pronoun} reliably get to ${where}-area providers?`;
    },
    quickReplies: () => [
      { label: 'Has a car', value: 'Has reliable transport — a car' },
      { label: 'Transit only', value: 'Public transit only' },
      { label: 'No reliable transport', value: 'No reliable transport right now' },
    ],
    // Only worth asking once we know where they are.
    applicable: (ctx) => Boolean(ctx.county ?? ctx.city),
    partition: (m) => (m.counties.length > 1 ? 'multi_site' : 'single_site'),
  },
  {
    id: 'incomeUrgency',
    field: 'incomeUrgency',
    baseValue: 0.75,
    prompt: (mode) =>
      `${s(mode).pronoun === 'you' ? 'Do you' : 'Do they'} need income coming in soon, or is there room to train first?`,
    quickReplies: () => [
      { label: 'Needs income now', value: 'Needs income as soon as possible' },
      { label: 'Can train first', value: 'Can focus on training for a few months' },
      { label: 'Open to both', value: 'Open to either' },
    ],
    // This is the sharpest split in the catalogue: earn-now vs train-first.
    partition: (m) =>
      /job-search|hiring-events|recruitment/i.test(m.slug)
        ? 'earn_now'
        : /training|scholarship|metrix|internship/i.test(m.slug)
          ? 'train_first'
          : 'either',
  },
  {
    id: 'employmentStatus',
    field: 'employmentStatus',
    baseValue: 0.5,
    prompt: (mode) =>
      `And ${s(mode).pronoun === 'you' ? 'are you' : 'are they'} working at the moment?`,
    quickReplies: () => [
      { label: 'Not working', value: 'Not currently working' },
      { label: 'Recently laid off', value: 'Recently laid off' },
      { label: 'Working, want better', value: 'Working but looking for something better' },
    ],
    partition: (m) => (/layoff|rapid|dislocated/i.test(m.slug) ? 'layoff' : 'other'),
  },
  {
    id: 'age',
    field: 'age',
    baseValue: 0.55,
    prompt: (mode) =>
      `How old ${s(mode).pronoun === 'you' ? 'are you' : 'are they'}? Some youth programmes have an age range.`,
    quickReplies: () => [
      { label: 'Under 18', value: 'Under 18' },
      { label: '18–24', value: 'Aged 18 to 24' },
      { label: '25–54', value: 'Aged 25 to 54' },
      { label: '55+', value: 'Aged 55 or older' },
    ],
    partition: (m) => (/internship|youth/i.test(m.slug) ? 'age_gated' : 'open'),
  },
];

/** Normalised Shannon entropy of how a question splits the candidate set. */
function entropy(buckets: Map<string, number>, total: number): number {
  if (total === 0 || buckets.size <= 1) return 0;
  let h = 0;
  for (const n of buckets.values()) {
    const p = n / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h / Math.log2(buckets.size);
}

export type QuestionChoice = {
  question: Question;
  /** 0–1; higher means this answer would narrow things more. */
  gain: number;
};

/**
 * Picks the single most useful next question.
 *
 * Returns null when nothing left to ask would change the outcome — the signal
 * to stop clarifying and show results, which is what prevents the infinite
 * question loop the brief warns about.
 */
/** How many times we have put a given question to them. */
function timesAsked(asked: string[], id: string): number {
  return asked.filter((a) => a === id).length;
}

/** Ask twice at most; past that, silence is an answer of its own. */
const MAX_ASKS = 2;

/** Questions whose answers change the shortlist enough to be worth waiting for. */
const DECISIVE: QuestionId[] = ['transportation', 'incomeUrgency'];

export function selectNextQuestion(
  ctx: CounselorContext,
  candidates: ProgramMatch[],
  asked: string[],
): QuestionChoice | null {
  const live = candidates.filter((c) => c.state !== 'mismatch');

  const scored = QUESTIONS.filter((q) => {
    if (q.applicable && !q.applicable(ctx)) return false;
    if (isAnswered(q, ctx)) return false;
    // Being asked is not the same as being answered — people often reply to
    // something else first. Allow one more attempt, then let it go rather
    // than badgering them.
    return timesAsked(asked, q.id) < MAX_ASKS;
  }).map((q) => {
    const buckets = new Map<string, number>();
    for (const m of live) {
      const key = q.partition(m);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    // Blend measured split with the question's intrinsic usefulness, so a
    // thin catalogue still asks sensible things rather than nothing.
    const measured = entropy(buckets, live.length);
    const base = live.length >= 3 ? measured * 0.65 + q.baseValue * 0.35 : q.baseValue;
    // A question they already sidestepped goes behind anything still fresh.
    const gain = timesAsked(asked, q.id) > 0 ? base * 0.5 : base;
    return { question: q, gain };
  });

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.gain - a.gain);

  const best = scored[0]!;
  // Below this, asking costs the user more than the answer is worth.
  if (best.gain >= 0.25) return best;

  // …except for the handful that genuinely decide the shortlist. Dropping one
  // of these because a re-ask scored low would send us to recommendations
  // while still missing the thing we said we needed.
  return scored.find((x) => DECISIVE.includes(x.question.id)) ?? null;
}

function isAnswered(q: Question, ctx: CounselorContext): boolean {
  if (q.id === 'population') return ctx.population.length > 0;
  const value = ctx[q.field];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0 && value !== 'unknown';
  return true;
}

/** Context dimensions considered, for the narrowing dot visualisation. */
export function criteriaFor(ctx: CounselorContext) {
  return [
    { key: 'audience', label: 'Who it is for', applied: Boolean(ctx.audience) },
    { key: 'county', label: 'Location', applied: Boolean(ctx.county ?? ctx.city) },
    { key: 'population', label: 'Population', applied: ctx.population.length > 0 },
    { key: 'careerInterest', label: 'Career direction', applied: Boolean(ctx.careerInterest) },
    { key: 'education', label: 'Education', applied: Boolean(ctx.education && ctx.education !== 'unknown') },
    { key: 'transportation', label: 'Transport', applied: Boolean(ctx.transportation && ctx.transportation !== 'unknown') },
    { key: 'incomeUrgency', label: 'Income urgency', applied: Boolean(ctx.incomeUrgency && ctx.incomeUrgency !== 'unknown') },
  ];
}

/**
 * Whether to stop clarifying.
 *
 * Deliberately conservative: knowing three things about someone is not the
 * same as having asked the questions that actually separate the options.
 * Transport and income urgency change the shortlist more than anything else,
 * so while either is unanswered and still worth asking we keep going — that
 * is what makes this feel like a counselor rather than a form.
 *
 * `selectNextQuestion` remains the real authority: when it returns null there
 * is nothing useful left to ask and we move on regardless.
 */
export function readyForResults(
  ctx: CounselorContext,
  candidates: ProgramMatch[],
  asked: string[] = [],
): boolean {
  const applied = criteriaFor(ctx).filter((c) => c.applied).length;
  const live = candidates.filter((c) => c.state !== 'mismatch').length;

  const outstanding = DECISIVE.filter((id) => {
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q || (q.applicable && !q.applicable(ctx))) return false;
    if (isAnswered(q, ctx)) return false;
    // Still worth waiting for while we may legitimately ask again.
    return timesAsked(asked, id) < MAX_ASKS;
  });
  if (outstanding.length > 0) return false;

  return applied >= 3 || (live > 0 && live <= 3 && applied >= 2);
}
