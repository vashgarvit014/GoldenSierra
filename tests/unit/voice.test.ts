import { describe, expect, it } from 'vitest';
import { listingReason, person, polishLead, pronounIn, stripUncitedFacts } from '@/lib/conversation/voice';
import { QUESTIONS } from '@/lib/counselor/questions';
import { targetShortlist } from '@/lib/conversation/qualify';
import { mergeContext, ruleExtract } from '@/lib/counselor/extract';
import type { CounselorContext } from '@/types/counselor';
import type { JobMatch } from '@/types/navigator';

const q = (id: string) => QUESTIONS.find((x) => x.id === id)!;
const ctx = (over: Partial<CounselorContext> = {}): CounselorContext => ({ mode: 'self', population: [], barriers: [], ...over });

describe('shared voice: lead-ins', () => {
  it('drops praise, stock acknowledgements and self-narration', () => {
    for (const t of ["That's a solid start.", 'Thanks for sharing that.', "I'll look for listings in Placer County.", 'It sounds like you are unsure.', 'Got it.', "I've noted your interest in healthcare."]) {
      expect(polishLead(t)).toBe('');
    }
  });
  it('keeps one specific sentence, drops the rest and any unsourced labour-market claim', () => {
    expect(polishLead('Moving from retail into an office is a common path. Office roles are in high demand.')).toBe('Moving from retail into an office is a common path.');
    expect(polishLead('Clerk roles are in high demand around Roseville.')).toBe('');
  });
  it('never opens two turns the same way, and never asks', () => {
    expect(polishLead('Placer County narrows things down.', { previous: ['Placer County is where you are.'] })).toBe('');
    expect(polishLead('Where do you live?')).toBe('Where do you live.');
  });
  it('uncited facts in a draft are removed before polishing', () => {
    expect(stripUncitedFacts('Golden Sierra offers free CNA classes.', 'I want healthcare work')).toBe('');
  });
});

describe('shared voice: person and agreement', () => {
  it('self → you; helper → they, or she/he when the user said so, with agreeing verbs', () => {
    expect(q('county').prompt('self', ctx())).toBe('Which county are you in?');
    expect(q('county').prompt('helper', ctx({ mode: 'helper' }))).toBe('Which county are they in?');
    expect(q('county').prompt('helper', ctx({ mode: 'helper', pronoun: 'she' }))).toBe('Which county is she in?');
    expect(q('education').prompt('helper', ctx({ mode: 'helper', pronoun: 'he' }))).toBe('Has he finished high school or a GED?');
    expect(person({ mode: 'helper', pronoun: 'she' }).doHave).toBe('does she have');
  });
  it('the pronoun is picked up from how the helper refers to the person', () => {
    expect(pronounIn('My son is 19')).toBe('he');
    expect(pronounIn('She worked as a cashier')).toBe('she');
    const c = mergeContext(ctx({ mode: 'helper' }), ruleExtract('She worked as a cashier for 4 years.', ctx({ mode: 'helper' })));
    expect(c.pronoun).toBe('she');
  });
  it('the starting-point question matches the mode', () => {
    expect(q('incomeUrgency').prompt('self', ctx())).toBe('Are you mainly looking for a job, training, or both?');
    expect(q('incomeUrgency').quickReplies('self').map((r) => r.label)).toEqual(['Find a job', 'Explore training', 'Both']);
    expect(q('incomeUrgency').prompt('helper', ctx({ mode: 'helper' }))).toMatch(/person you’re supporting need right now\?$/);
    // The reply values are understood by the extractor.
    for (const [v, want] of [['I need a job soon', 'immediate'], ["I'd like to train first", 'can_train_first'], ['Open to both', 'flexible']] as const) {
      expect(ruleExtract(v, ctx()).incomeUrgency).toBe(want);
    }
  });
  it('listing reasons read naturally', () => {
    expect(listingReason(['Electrician'])).toBe('The Electrician listing asks for this.');
    expect(listingReason(['A', 'B', 'C'])).toBe('Three of the matching job listings ask for this.');
  });
});

describe('context: goals are not experience; a stated job goal settles "job or training?"', () => {
  it('"want to work as an electrician" is a target, not experience; with "1 year of experience" it is both', () => {
    expect(ruleExtract('I want to work as an electrician.', ctx())).toMatchObject({ occupations: ['electrician'] });
    expect(ruleExtract('I want to work as an electrician.', ctx()).experience).toBeUndefined();
    expect(ruleExtract('I want to be an electrician. I have 1 year of experience and no license.', ctx())).toMatchObject({ occupations: ['electrician'], experience: ['electrician'] });
    expect(ruleExtract('I worked 5 years in retail as a cashier.', ctx()).occupations).toBeUndefined();
  });
  it('looking for a job or work records the goal, and the job-or-training question no longer applies', () => {
    for (const t of ['I need a job.', "I'm looking for warehouse work.", 'She wants an office job.']) expect(ruleExtract(t, ctx()).jobGoalStated).toBe(true);
    expect(ruleExtract('I want job training.', ctx()).jobGoalStated).toBeUndefined();
    expect(q('incomeUrgency').applicable!(ctx({ jobGoalStated: true }))).toBe(false);
  });
});

describe('qualification questions follow the role they described', () => {
  const m = (id: string, kind: JobMatch['kind'], relation: JobMatch['relation'] = 'related') => ({ id, kind, relation, listingStatus: 'open' }) as unknown as JobMatch;
  it('exact-role listings when present, otherwise related ones; never same-field or transferable', () => {
    expect(targetShortlist([m('a', 'related'), m('b', 'exact'), m('c', 'sector')]).map((x) => x.id)).toEqual(['b']);
    expect(targetShortlist([m('a', 'related'), m('c', 'sector')]).map((x) => x.id)).toEqual(['a']);
    expect(targetShortlist([m('c', 'sector'), m('d', 'transferable')])).toEqual([]);
    // cashier → Sales Manager is a supervisory step up, not the role asked about
    expect(targetShortlist([m('s', 'related', 'supervisory')])).toEqual([]);
  });
});
