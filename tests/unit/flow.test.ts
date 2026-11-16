import { describe, expect, it } from 'vitest';
import {
  FlowPayloadSchema,
  composeResults,
  initialFlow,
  knownFactsRecord,
  readFlow,
  stripUncitedFacts,
  transition,
  uncertaintiesFor,
  wantsResults,
} from '@/lib/conversation/flow';
import { focusQueries, guidedQuestion } from '@/lib/conversation/evidence';
import { changedFields, mergeContext, ruleExtract } from '@/lib/counselor/extract';
import { routeMessage } from '@/lib/rag/routing';
import { NO_ANSWER_TEXT } from '@/lib/rag/strict';
import type { CounselorContext } from '@/types/counselor';

const ctx = (over: Partial<CounselorContext> = {}): CounselorContext => ({ mode: 'self', population: [], barriers: [], ...over });
const FOSTER = "I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.";

describe('state machine', () => {
  it('moves through discovery, clarification, readiness, results and follow-up from evidence, not message counts', () => {
    expect(transition('START', { type: 'ASK', knownCount: 0 })).toBe('DISCOVERING_NEEDS');
    expect(transition('START', { type: 'ASK', knownCount: 4 })).toBe('CLARIFYING');
    expect(transition('DISCOVERING_NEEDS', { type: 'ASK', knownCount: 2 })).toBe('CLARIFYING');
    expect(transition('CLARIFYING', { type: 'READY' })).toBe('READY_FOR_RECOMMENDATIONS');
    expect(transition('READY_FOR_RECOMMENDATIONS', { type: 'RESULTS_SHOWN', hadResults: false })).toBe('SHOWING_RESULTS');
    expect(transition('READY_FOR_RECOMMENDATIONS', { type: 'RESULTS_SHOWN', hadResults: true })).toBe('FOLLOW_UP');
    expect(transition('SHOWING_RESULTS', { type: 'ASK', knownCount: 5 })).toBe('FOLLOW_UP');
  });
  it('a direct factual lookup leaves the guided stage untouched', () => {
    for (const s of ['START', 'CLARIFYING', 'SHOWING_RESULTS'] as const) expect(transition(s, { type: 'LOOKUP' })).toBe(s);
  });
  it('the user can ask for results early', () => {
    for (const m of ['Just show me the options', 'Can you give me some recommendations now?', 'What do you recommend?', 'show me results']) expect(wantsResults(m)).toBe(true);
    for (const m of ['She has no car', 'What is Orbit?', 'Placer County']) expect(wantsResults(m)).toBe(false);
  });
  it('a malformed stored flow starts fresh instead of failing', () => {
    expect(readFlow({ stage: 'NOPE' })).toEqual(initialFlow());
    expect(readFlow(undefined).stage).toBe('START');
    const ok = { ...initialFlow(), stage: 'CLARIFYING', askedQuestions: ['county'], pendingQuestion: 'county' };
    expect(readFlow(ok).pendingQuestion).toBe('county');
  });
  it('the response contract is validated (at most four quick replies, one question)', () => {
    const base = { stage: 'CLARIFYING', route: 'personal', question: 'Q?', knownFacts: {}, uncertainties: [], canShowResults: true, corrections: [] };
    expect(FlowPayloadSchema.safeParse({ ...base, quickReplies: [{ label: 'a', value: 'a' }] }).success).toBe(true);
    expect(FlowPayloadSchema.safeParse({ ...base, quickReplies: Array(5).fill({ label: 'a', value: 'a' }) }).success).toBe(false);
    expect(FlowPayloadSchema.safeParse({ ...base, stage: 'ASKING', quickReplies: [] }).success).toBe(false);
  });
});

describe('UNDERSTAND: extraction from the first message', () => {
  it('captures helper mode, age, population, interest and education without asking again', () => {
    const r = ruleExtract(FOSTER, ctx());
    expect(r.mode).toBe('helper');
    expect(r.age).toBe(19);
    expect(r.population).toEqual(expect.arrayContaining(['former_foster_youth', 'youth']));
    expect(r.careerInterest).toBe('healthcare');
    expect(r.education).toBe('no_hs_diploma');
  });
  it('reads GED wording in either order, and negation before completion', () => {
    expect(ruleExtract("She hasn't completed her GED. She has a car.", ctx()).education).toBe('no_hs_diploma');
    expect(ruleExtract('GED incomplete', ctx()).education).toBe('no_hs_diploma');
    expect(ruleExtract('Actually she finished her GED last month', ctx()).education).toBe('ged_or_hs');
    expect(ruleExtract('She completed high school', ctx()).education).toBe('ged_or_hs');
  });
  it('reads transport, place and urgency from a reply', () => {
    const r = ruleExtract('She has no reliable transportation and lives near Auburn.', ctx());
    expect(r).toMatchObject({ transportation: 'none', city: 'auburn', county: 'Placer' });
    expect(ruleExtract('She needs income urgently.', ctx()).incomeUrgency).toBe('immediate');
    expect(ruleExtract('Actually, she does have a car now.', ctx()).transportation).toBe('own_vehicle');
  });
  it('a correction replaces the old answer and its consequence, and is reported as a correction', () => {
    const before = mergeContext(ctx({ mode: 'helper' }), ruleExtract('She has no reliable transportation near Auburn', ctx()));
    expect(before.barriers).toContain('transportation');
    const after = mergeContext(before, ruleExtract('Actually, she does have a car now.', before));
    expect(after.transportation).toBe('own_vehicle');
    expect(after.barriers).not.toContain('transportation');
    expect(changedFields(before, after)).toEqual(['transportation']);
    expect(changedFields(ctx(), ctx({ mode: 'helper', county: 'Placer' }))).toEqual([]); // first answers are not corrections
  });
});

describe('routing: personal situations vs direct factual questions', () => {
  it('third-person situations are personal; definitions are factual', () => {
    expect(routeMessage('She is 19 and needs a job').kind).toBe('personal');
    expect(routeMessage(FOSTER).kind).toBe('personal');
    expect(routeMessage('What is Orbit?').kind).toBe('factual');
    expect(routeMessage('Placer County', { fallback: 'personal' }).kind).toBe('personal');
    expect(routeMessage('WIOA', { fallback: 'factual' }).kind).toBe('factual');
  });
});

describe('ACKNOWLEDGE: no uncited facts on a clarifying turn', () => {
  it('keeps conversational sentences, including figures the user gave', () => {
    const out = stripUncitedFacts("Got it — a 19-year-old interested in healthcare. I'll look for options that fit her situation.", FOSTER);
    expect(out).toContain('19-year-old');
    expect(out).toContain("I'll look for options");
  });
  it('drops sentences that assert services, eligibility, money, links or invented names', () => {
    const user = FOSTER;
    for (const bad of [
      'Golden Sierra offers a free CNA course.',
      'She is eligible for youth services.',
      'Training pays $18 an hour.',
      'You can apply at www.example.org today.',
      'The Healthcare Pathways Academy is a good fit.',
      'Most programs take 12 weeks.',
    ]) expect(stripUncitedFacts(`Got it. ${bad}`, user)).toBe('Got it.');
  });
});

describe('facts, uncertainty and focused retrieval', () => {
  const foster = mergeContext(ctx(), ruleExtract(FOSTER, ctx()));
  it('known facts are a plain record of what was volunteered', () => {
    const k = knownFactsRecord(foster);
    expect(k).toMatchObject({ who: 'Helping someone else', careerInterest: 'Healthcare', age: '19 years old' });
    expect(k.situation).toMatch(/Former foster youth/);
  });
  it('uncertainties list only unanswered dimensions that matter', () => {
    expect(uncertaintiesFor(foster)).toEqual(expect.arrayContaining(['which county', 'whether income is needed right away']));
    expect(uncertaintiesFor({ ...foster, county: 'Placer', incomeUrgency: 'immediate', transportation: 'none', employmentStatus: 'unemployed' })).toEqual([]);
  });
  it('one focused search per expressed need, derived from context (not a fixed list)', () => {
    const full = { ...foster, city: 'auburn', county: 'Placer' as const, transportation: 'none' as const, incomeUrgency: 'immediate' as const };
    const f = focusQueries(full, 'x');
    expect(f.map((x) => x.key)).toEqual(['career', 'education', 'work', 'youth', 'location']);
    expect(f.find((x) => x.key === 'location')).toMatchObject({ require: 'auburn' });
    expect(focusQueries(ctx({ audience: 'employer' }), 'x').map((x) => x.key)).toEqual(['employer']);
    expect(focusQueries(ctx(), 'help with resumes')).toEqual([{ key: 'request', label: 'the request', query: 'help with resumes' }]);
    expect(guidedQuestion(full, f)).toMatch(/Do not say anyone is eligible/);
  });
});

describe('RECOMMEND: composition', () => {
  const base = { ctx: ctx({ mode: 'helper' }), focuses: [{ key: 'work', label: 'finding paid work soon', query: 'q' }], corrections: [], uncertainties: [], refine: null };
  it('a refusal keeps the exact no-answer sentence', () => {
    const m = composeResults({ ...base, verified: NO_ANSWER_TEXT, answered: false });
    expect(m.split('\n\n')).toContain(NO_ANSWER_TEXT);
  });
  it('an answer keeps the verified text, the staff-confirmation caveat, gaps and what is still unknown', () => {
    const m = composeResults({ ...base, verified: 'Job Connections is a monthly event. [1]', answered: true, uncovered: ['finishing a GED or diploma'], uncertainties: ['transport'], refine: 'Can they get to a training site?', corrections: ['transportation'] });
    expect(m).toMatch(/^Thanks — I've updated that\./);
    expect(m).toContain('Job Connections is a monthly event. [1]');
    expect(m).toContain("I didn't find indexed information on finishing a GED or diploma.");
    expect(m).toContain('confirmed by Golden Sierra staff');
    expect(m).toContain('Still unknown: transport. Can they get to a training site?');
  });
});
