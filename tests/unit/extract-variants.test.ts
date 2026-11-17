import { describe, expect, it } from 'vitest';
import { changedFields, mergeContext, ruleExtract } from '@/lib/counselor/extract';
import type { CounselorContext } from '@/types/counselor';

/** Natural-language variations and corrections the deterministic extractor must read (no model involved). */
const ctx = (over: Partial<CounselorContext> = {}): CounselorContext => ({ mode: 'self', population: [], barriers: [], ...over });

const CASES: [string, Partial<CounselorContext>][] = [
  // age
  ['She just turned 20.', { age: 20, ageBand: '18_24' }],
  ['He is a 22 y/o', { age: 22 }],
  ['my son, 17, wants a summer job', { age: 17, ageBand: 'under_18' }],
  ['Under 18', { ageBand: 'under_18' }],
  // education
  ['She dropped out of high school', { education: 'no_hs_diploma' }],
  ['never finished high school', { education: 'no_hs_diploma' }],
  ["He's taking GED classes", { education: 'working_on_ged' }],
  ['She graduated high school last year', { education: 'ged_or_hs' }],
  ['high school grad', { education: 'ged_or_hs' }],
  ['took a few community college classes', { education: 'some_college' }],
  ["has a bachelor's in biology", { education: 'degree' }],
  // transport
  ["She doesn't have a car", { transportation: 'none' }],
  ['he does not have a vehicle', { transportation: 'none' }],
  ['lost her license', { transportation: 'none' }],
  ['She takes the bus everywhere', { transportation: 'transit_only' }],
  ['relies on public transportation', { transportation: 'transit_only' }],
  ['She drives', { transportation: 'own_vehicle' }],
  // income urgency
  ['She needs a paycheck asap', { incomeUrgency: 'immediate' }],
  ['bills are due and he needs money fast', { incomeUrgency: 'immediate' }],
  ["can't afford to wait for training", { incomeUrgency: 'immediate' }],
  ['She has savings and is not in a hurry', { incomeUrgency: 'can_train_first' }],
  // employment
  ['Not currently working', { employmentStatus: 'unemployed' }],
  ['between jobs right now', { employmentStatus: 'unemployed' }],
  ['She lost her job last month', { employmentStatus: 'unemployed' }],
  ['works part-time at a store', { employmentStatus: 'underemployed' }],
  ['I was laid off from a warehouse job', { employmentStatus: 'laid_off', audience: 'job_seeker' }],
  // career
  ['She wants to become a nurse', { careerInterest: 'healthcare' }],
  ['Still deciding what kind of work', { careerInterest: 'still deciding' }],
  ['he has no idea what job he wants', { careerInterest: 'still deciding' }],
  // audience
  ['I own a restaurant in Roseville and need to hire cooks', { audience: 'employer', city: 'roseville', county: 'Placer' }],
  ["We're looking to hire two warehouse workers", { audience: 'employer' }],
  ['I am a veteran looking for work', { audience: 'job_seeker' }],
];

describe('ruleExtract: natural-language variations', () => {
  it.each(CASES)('%s', (message, expected) => {
    expect(ruleExtract(message, ctx())).toMatchObject(expected);
  });

  it('negated or unrelated wording does not set facts', () => {
    expect(ruleExtract("I'm not sure which county", ctx()).county).toBeUndefined();
    expect(ruleExtract('Still deciding what kind of work', ctx()).county).toBeUndefined();
    expect(ruleExtract("She doesn't have a car", ctx()).transportation).toBe('none'); // not "has a car"
    expect(ruleExtract('He is not a veteran', ctx()).population ?? []).not.toContain('veteran');
  });
});

describe('corrections', () => {
  const run = (msgs: string[]) => msgs.reduce((c, m) => mergeContext(c, ruleExtract(m, c)), ctx({ mode: 'helper' }));

  it('"I meant X, not Y" takes X', () => {
    const before = run(['She lives in Placer County']);
    const after = run(['She lives in Placer County', 'Sorry, I meant El Dorado, not Placer']);
    expect(after.county).toBe('El Dorado');
    expect(changedFields(before, after)).toEqual(['county']);
  });

  it('a corrected town replaces the old town and its county', () => {
    const after = run(['She lives near Auburn', 'Actually she moved to Placerville']);
    expect(after).toMatchObject({ city: 'placerville', county: 'El Dorado' });
  });

  it('a later age, education or job status replaces the earlier one', () => {
    expect(run(['She is 19', "Actually she's 20"]).age).toBe(20);
    expect(run(["She hasn't finished her GED", 'Update: she passed the GED']).education).toBe('ged_or_hs');
    expect(run(['She is unemployed', 'She just found a part-time job']).employmentStatus).toBe('underemployed');
    expect(run(['She needs income urgently', 'Actually there is no rush, she can train first']).incomeUrgency).toBe('can_train_first');
  });

  it('"not a veteran" withdraws an earlier veteran tag', () => {
    expect(run(['He is a veteran', "Sorry, he's not a veteran — his father was"]).population).not.toContain('veteran');
  });
});
