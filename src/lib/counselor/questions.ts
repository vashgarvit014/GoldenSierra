import type {
  CounselorContext,
  ProgramMatch,
  QuickReply,
  SessionMode,
} from '@/types/counselor';
import { SUBJECT } from '@/types/counselor';
import { mergeContext, ruleExtract } from './extract';
import { requirementVerdicts, type ProgramRow } from './matching';
import { focusQueries } from '../conversation/focus';
import { relatedOf } from '../jobs/occupations';
import { person } from '../conversation/voice';

/**
 * Adaptive next-question selection.
 *
 * This is the behaviour the brief cares most about, so it is deterministic
 * rather than left to the model: the LLM writes the sentence, but *which*
 * question gets asked is decided here, from evidence.
 *
 * The rule is information gain, measured against the real catalogue. For each
 * unanswered question, every offered answer is simulated: the answer is read
 * by the same extractor as a real reply, the live programs are re-matched
 * against their published eligibility rules (service area, age, audience,
 * veteran status…), and the retrieval plan is rebuilt. A question whose answers
 * all lead to the same verdicts and the same searches cannot change the outcome
 * and is skipped, however standard it looks. There is no fixed order: the
 * per-question base value only breaks ties.
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
  | 'population'
  | 'rolePreference';

export type Question = {
  id: QuestionId;
  /** Context field it fills; used to detect "already answered". */
  field: keyof CounselorContext;
  /** Written per mode so helper mode says "they", not "you". */
  prompt: (mode: SessionMode, ctx: CounselorContext) => string;
  quickReplies: (mode: SessionMode) => QuickReply[];
  /** Tie-breaker only (10% of the score); the answer simulation decides. */
  baseValue: number;
  /** Never ask unless this holds. */
  applicable?: (ctx: CounselorContext) => boolean;
};

const s = (mode: SessionMode) => SUBJECT[mode];
const who = (mode: SessionMode, ctx?: CounselorContext) => person({ mode, pronoun: ctx?.pronoun });
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** Questions about a job seeker's own situation do not apply to an employer. */
const seeker = (ctx: CounselorContext) => ctx.audience !== 'employer';

export const QUESTIONS: Question[] = [
  {
    id: 'audience',
    field: 'audience',
    baseValue: 0.9,
    // In helper mode the user is supporting a person, so the job-seeker side
    // is already implied — asking "are you looking for work yourself" there
    // just confuses them. Only ask when it is genuinely ambiguous.
    applicable: (ctx) => ctx.mode === 'self',
    prompt: () => 'Are you looking for work yourself, or hiring for a business?',
    quickReplies: () => [
      { label: 'Looking for work', value: 'I am looking for work' },
      { label: "I'm an employer", value: 'I am an employer looking to hire' },
    ],
  },
  {
    id: 'county',
    field: 'county',
    baseValue: 0.85,
    prompt: (mode, ctx) => `Which county ${who(mode, ctx).be} ${who(mode, ctx).subj} in?`,
    quickReplies: () => [
      { label: 'Placer', value: 'Placer County' },
      { label: 'El Dorado', value: 'El Dorado County' },
      { label: 'Alpine', value: 'Alpine County' },
      { label: 'Not sure', value: "I'm not sure which county" },
    ],
  },
  {
    id: 'careerInterest',
    field: 'careerInterest',
    baseValue: 0.7,
    prompt: (mode, ctx) => `What kind of work ${who(mode, ctx).be} ${who(mode, ctx).subj} hoping to find? A rough idea is fine.`,
    quickReplies: () => [
      { label: 'Healthcare', value: 'Interested in healthcare' },
      { label: 'Trades / construction', value: 'Interested in the trades or construction' },
      { label: 'Office / admin', value: 'Interested in office or administrative work' },
      { label: 'Still deciding', value: 'Still deciding what kind of work' },
    ],
    applicable: seeker,
  },
  {
    id: 'education',
    field: 'education',
    baseValue: 0.65,
    prompt: (mode, ctx) => `${cap(who(mode, ctx).haveQ)} finished high school or a GED?`,
    quickReplies: () => [
      { label: 'GED / diploma done', value: 'GED or high school diploma completed' },
      { label: 'Still working on it', value: 'Still working on the GED' },
      { label: 'Not started', value: 'No high school diploma or GED yet' },
      { label: 'Some college', value: 'Has some college' },
    ],
    applicable: seeker,
  },
  {
    id: 'transportation',
    field: 'transportation',
    baseValue: 0.6,
    prompt: (mode, ctx) => {
      const where = ctx.city ?? ctx.county ?? 'the area';
      return `Can ${who(mode, ctx).subj} reliably get around ${where === 'the area' ? 'the area' : `the ${where} area`}, for example by car or bus?`;
    },
    quickReplies: () => [
      { label: 'Has a car', value: 'Has reliable transport — a car' },
      { label: 'Transit only', value: 'Public transit only' },
      { label: 'No reliable transport', value: 'No reliable transport right now' },
    ],
    // Only worth asking once we know where they are.
    applicable: (ctx) => seeker(ctx) && Boolean(ctx.county ?? ctx.city),
  },
  {
    id: 'incomeUrgency',
    field: 'incomeUrgency',
    baseValue: 0.75,
    // Also the starting-point question: it separates job-search help from training.
    prompt: (mode, ctx) =>
      mode === 'helper'
        ? ctx?.pronoun
          ? `What kind of help ${who(mode, ctx).do} ${who(mode, ctx).subj} need most right now?`
          : 'What kind of help does the person you’re supporting need right now?'
        : `${who(mode, ctx).BeQ} mainly looking for a job, training, or both?`,
    quickReplies: (mode) => [
      ...(mode === 'helper'
        ? [
            { label: 'Finding work', value: 'They need work soon' },
            { label: 'Career training', value: "They'd like to train first" },
            { label: 'Not sure yet', value: 'Not sure yet' },
          ]
        : [
            { label: 'Find a job', value: 'I need a job soon' },
            { label: 'Explore training', value: "I'd like to train first" },
            { label: 'Both', value: 'Open to both' },
          ]),
    ],
    applicable: (ctx) => seeker(ctx) && !ctx.jobGoalStated,
  },
  {
    id: 'employmentStatus',
    field: 'employmentStatus',
    baseValue: 0.5,
    prompt: (mode, ctx) => `${who(mode, ctx).BeQ} working at the moment?`,
    quickReplies: () => [
      { label: 'Not working', value: 'Not currently working' },
      { label: 'Recently laid off', value: 'Recently laid off' },
      { label: 'Working, want better', value: 'Working but looking for something better' },
    ],
    applicable: seeker,
  },
  {
    id: 'age',
    field: 'age',
    baseValue: 0.55,
    prompt: (mode, ctx) => `How old ${who(mode, ctx).be} ${who(mode, ctx).subj}? Some youth programs have an age range.`,
    quickReplies: () => [
      { label: 'Under 18', value: 'Under 18' },
      { label: '18–24', value: 'Aged 18 to 24' },
      { label: '25–54', value: 'Aged 25 to 54' },
      { label: '55+', value: 'Aged 55 or older' },
    ],
    applicable: seeker,
  },
  {
    id: 'rolePreference',
    field: 'rolePreference',
    baseValue: 0.6,
    prompt: (mode, ctx) => `Would ${who(mode, ctx).subj} like to stay in roles like this one, or also consider a lead or supervisory role?`,
    quickReplies: () => [
      { label: 'Same kind of role', value: 'Hands-on technical work' },
      { label: 'Supervisory roles', value: 'Supervisory or lead roles' },
      { label: 'Open to both', value: 'Open to both technical and supervisory roles' },
    ],
    // Only when a role they have done or want has a lead/supervisory step in the occupation taxonomy.
    applicable: (ctx) =>
      seeker(ctx) && [...relatedOf([...(ctx.occupations ?? []), ...(ctx.experience ?? [])]).values()].includes('supervisory'),
  },
];

/** Shannon entropy of the answer outcomes, normalised by the number of answers offered. */
function entropy(buckets: Map<string, number>, total: number, options = buckets.size): number {
  if (total === 0 || buckets.size <= 1 || options <= 1) return 0;
  let h = 0;
  for (const n of buckets.values()) {
    const p = n / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h / Math.log2(options);
}

export type AnswerSplit = {
  /** 0–1: how differently the next step goes across the offered answers (1 = every answer differs). */
  split: number;
  /** Some answer changes a program's verdict under its published rules (not just what we search for). */
  changesRequirements: boolean;
};

/**
 * Simulates each offered answer: re-evaluate the programs' published requirements and rebuild the
 * retrieval plan. Answers the extractor cannot read leave the context unchanged — an honest "no information".
 */
/** Extra published requirements to simulate (job listings' qualifications, location, deadline). */
export type ExtraVerdicts = (ctx: CounselorContext) => string;

export function answerSplit(q: Question, ctx: CounselorContext, programs: ProgramRow[], extra?: ExtraVerdicts): AnswerSplit {
  const replies = q.quickReplies(ctx.mode);
  const verdictKeys: string[] = [];
  const outcomes = new Map<string, number>();
  for (const r of replies) {
    const next = mergeContext(ctx, ruleExtract(r.value, ctx));
    const verdicts = programs.map((p) => requirementVerdicts(p, next)).join('|') + (extra ? `#jobs:${extra(next)}` : '');
    const plan = focusQueries(next, '').map((f) => f.query).join('|');
    verdictKeys.push(verdicts);
    const key = `${verdicts}#${plan}`;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
  }
  return { split: entropy(outcomes, replies.length, replies.length), changesRequirements: new Set(verdictKeys).size > 1 };
}

export type QuestionChoice = {
  question: Question;
  /** 0–1; higher means this answer would narrow things more. */
  gain: number;
};

/** How many times we have put a given question to them. */
function timesAsked(asked: string[], id: string): number {
  return asked.filter((a) => a === id).length;
}

/** Ask twice at most; past that, silence is an answer of its own. */
const MAX_ASKS = 2;
/** Below this, asking costs the user more than the answer is worth. */
const MIN_GAIN = 0.2;
/** Total questions put before results are shown regardless — no indefinite questioning. */
export const QUESTION_BUDGET = 4;

function livePrograms(candidates: ProgramMatch[], programs: ProgramRow[]): ProgramRow[] {
  const live = new Set(candidates.filter((c) => c.state !== 'mismatch').map((c) => c.id));
  return programs.filter((p) => live.has(p.id));
}

function openQuestions(ctx: CounselorContext, asked: string[]): Question[] {
  return QUESTIONS.filter((q) => {
    if (q.applicable && !q.applicable(ctx)) return false;
    if (isAnswered(q, ctx)) return false;
    // Being asked is not the same as being answered — people often reply to
    // something else first. Allow one more attempt, then let it go rather
    // than badgering them.
    return timesAsked(asked, q.id) < MAX_ASKS;
  });
}

/**
 * Picks the single most useful next question, or null when nothing left to ask would change the
 * outcome — the signal to stop clarifying and show results (no infinite question loop).
 * `programs` are the catalogue rows with their rules; without them only the retrieval plan counts.
 */
export function selectNextQuestion(
  ctx: CounselorContext,
  candidates: ProgramMatch[],
  asked: string[],
  programs: ProgramRow[] = [],
  extra?: ExtraVerdicts,
): QuestionChoice | null {
  const live = livePrograms(candidates, programs);
  const scored = openQuestions(ctx, asked).map((q) => {
    const { split } = answerSplit(q, ctx, live, extra);
    const base = split * 0.9 + q.baseValue * 0.1;
    // A question they already sidestepped goes behind anything still fresh.
    return { question: q, gain: timesAsked(asked, q.id) > 0 ? base * 0.5 : base };
  });
  scored.sort((a, b) => b.gain - a.gain);
  const best = scored[0];
  return best && best.gain >= MIN_GAIN ? best : null;
}

function isAnswered(q: Question, ctx: CounselorContext): boolean {
  if (q.id === 'population') return ctx.population.length > 0;
  // "Under 18" answers the age question even without an exact age.
  if (q.id === 'age') return ctx.age != null || Boolean(ctx.ageBand);
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
 * Not while a decisive question is open. A question is decisive when its answer would change a
 * live program's verdict under its published rules (service area, age range, audience, veteran status)
 * and splits the outcomes substantially, or when every answer leads to a different next step
 * (earn now vs. train first). Each is put at most twice, and never more than QUESTION_BUDGET
 * questions in all. Otherwise, a few known dimensions suffice.
 */
export function readyForResults(
  ctx: CounselorContext,
  candidates: ProgramMatch[],
  asked: string[] = [],
  programs: ProgramRow[] = [],
  extra?: ExtraVerdicts,
): boolean {
  if (asked.length >= QUESTION_BUDGET) return true;
  const applied = criteriaFor(ctx).filter((c) => c.applied).length;
  const liveCount = candidates.filter((c) => c.state !== 'mismatch').length;
  const live = livePrograms(candidates, programs);
  const outstanding = openQuestions(ctx, asked).some((q) => {
    const { split, changesRequirements } = answerSplit(q, ctx, live, extra);
    return (changesRequirements && split >= 0.5) || split >= 0.9;
  });
  if (outstanding) return false;
  return applied >= 3 || (liveCount > 0 && liveCount <= 3 && applied >= 2);
}
