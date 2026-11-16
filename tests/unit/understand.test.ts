import { describe, expect, it } from 'vitest';
import { extractKeywords, mergeProfile, ruleBasedAnalysis } from '@/lib/rag/understand';
import type { UserProfile } from '@/types/chat';

/**
 * The rule-based layer is what the assistant falls back to when the language
 * model is slow or unavailable, so it has to stand on its own. It is also the
 * layer that decides what personal information gets extracted at all.
 */

const noHistory: { role: string; content: string }[] = [];

describe('ruleBasedAnalysis — intent', () => {
  it.each([
    ['I am unemployed and need to find a job', 'find_job'],
    ['Are there training scholarships available?', 'financial_assistance'],
    ['I want to learn a new skill', 'find_training'],
    ['How can Golden Sierra help my business hire employees?', 'employer_hiring'],
    ['Do I qualify for help?', 'eligibility'],
    ['Do I qualify for a training scholarship if I make $40,000 a year?', 'eligibility'],
    ['Am I eligible for the Elevate Your Future scholarship?', 'eligibility'],
    ['Who qualifies for tuition assistance?', 'eligibility'],
    ['Is there a scholarship for training?', 'financial_assistance'],
    ['Are there paid internships?', 'internship'],
    ['What is your phone number?', 'contact_referral'],
    ['What services does Golden Sierra provide?', 'general_info'],
  ])('classifies %j as %s', (message, expected) => {
    expect(ruleBasedAnalysis(message, noHistory).intent).toBe(expected);
  });

  it('routes an employer framing away from job seeker services', () => {
    const analysis = ruleBasedAnalysis('I need to train my staff', noHistory);
    expect(['employer_training', 'employer_hiring']).toContain(analysis.intent);
    expect(analysis.profileUpdates.audience).toBe('employer');
  });
});

describe('ruleBasedAnalysis — profile extraction', () => {
  it('extracts a county named directly', () => {
    expect(ruleBasedAnalysis('I live in Placer County', noHistory).profileUpdates.county).toBe('Placer');
    expect(ruleBasedAnalysis('I am in el dorado', noHistory).profileUpdates.county).toBe('El Dorado');
  });

  it('maps a known city to its county', () => {
    const analysis = ruleBasedAnalysis('I live in Roseville', noHistory);
    expect(analysis.profileUpdates.county).toBe('Placer');
    expect(analysis.profileUpdates.locationText).toBe('roseville');
  });

  it('extracts employment status', () => {
    expect(ruleBasedAnalysis('I am unemployed', noHistory).profileUpdates.employmentStatus).toBe('unemployed');
    expect(ruleBasedAnalysis('I was laid off last month', noHistory).profileUpdates.employmentStatus).toBe('laid_off');
  });

  it('extracts veteran status and age band', () => {
    const analysis = ruleBasedAnalysis("I'm a veteran and I'm 22", noHistory);
    expect(analysis.profileUpdates.isVeteran).toBe(true);
    expect(analysis.profileUpdates.ageBand).toBe('18_24');
  });

  it('never extracts identifying details', () => {
    const analysis = ruleBasedAnalysis(
      'My name is Jordan Smith, email jordan@example.com, phone 916-555-0100, SSN 123-45-6789.',
      noHistory,
    );

    const serialized = JSON.stringify(analysis.profileUpdates);
    expect(serialized).not.toMatch(/Jordan|Smith|example\.com|555-0100|123-45-6789/);
  });

  it('extracts a stated career interest', () => {
    const analysis = ruleBasedAnalysis('I am interested in healthcare', noHistory);
    expect(analysis.profileUpdates.careerInterests).toEqual(['healthcare']);
  });
});

describe('ruleBasedAnalysis — follow-ups and multi-part questions', () => {
  it('resolves a pronoun against the previous answer', () => {
    const history = [
      { role: 'user', content: 'What training is there?' },
      { role: 'assistant', content: 'You might look at **Training Scholarships** and **Paid Internships**.' },
    ];
    const analysis = ruleBasedAnalysis('Am I eligible for that?', history);

    expect(analysis.rewrittenQuery).toContain('Training Scholarships');
  });

  it('leaves a standalone question unchanged', () => {
    const message = 'What training scholarships does Golden Sierra offer to residents?';
    expect(ruleBasedAnalysis(message, noHistory).rewrittenQuery).toBe(message);
  });

  it('splits a multi-part question', () => {
    const analysis = ruleBasedAnalysis(
      'Can you help me find a job? Do you also offer training scholarships?',
      noHistory,
    );

    expect(analysis.isMultiPart).toBe(true);
    expect(analysis.subQuestions.length).toBeGreaterThan(1);
  });
});

describe('extractKeywords', () => {
  it('picks up program terms and place names', () => {
    const keywords = extractKeywords('Is WIOA funding available for training in El Dorado?');
    expect(keywords).toContain('WIOA');
    expect(keywords).toContain('El Dorado');
  });

  it('skips interrogatives that start a sentence', () => {
    expect(extractKeywords('What services do you offer?')).not.toContain('What');
  });
});

describe('mergeProfile', () => {
  it('lets new facts override old ones', () => {
    const merged = mergeProfile({ county: 'Placer' }, { county: 'Alpine' });
    expect(merged.county).toBe('Alpine');
  });

  it('keeps facts the latest message did not mention', () => {
    const merged = mergeProfile(
      { county: 'Placer', employmentStatus: 'unemployed' },
      { careerInterests: ['nursing'] },
    );

    expect(merged.county).toBe('Placer');
    expect(merged.employmentStatus).toBe('unemployed');
    expect(merged.careerInterests).toEqual(['nursing']);
  });

  it('unions array fields instead of replacing them', () => {
    const merged = mergeProfile({ careerInterests: ['nursing'] }, { careerInterests: ['welding'] });
    expect(merged.careerInterests).toEqual(['nursing', 'welding']);
  });

  it('ignores undefined and empty updates', () => {
    const existing: UserProfile = { county: 'Placer' };
    expect(mergeProfile(existing, { county: undefined, careerInterests: [] })).toEqual(existing);
  });
});

describe('follow-up resolution does not depend on one model sample', () => {
  const history = [
    { role: 'user', content: 'What is the Cobalt Heron Apprenticeship?' },
    { role: 'assistant', content: 'It is a training program with a new cohort every March.' },
  ];
  it('rule-based resolution names the topic from the previous question when the answer had no headings', () => {
    expect(ruleBasedAnalysis('And how much does it pay?', history).rewrittenQuery).toContain('Cobalt Heron Apprenticeship');
  });
  it('detects a rewrite that left the pronoun unresolved', async () => {
    const { leftUnresolved } = await import('@/lib/rag/understand');
    expect(leftUnresolved('And how much does it pay?', 'And how much does it pay?', history)).toBe(true);
    expect(leftUnresolved('And how much does it pay?', 'How much does the Cobalt Heron Apprenticeship pay?', history)).toBe(false);
    expect(leftUnresolved('What is Orbit?', 'What is Orbit?', history)).toBe(false); // no referent
    expect(leftUnresolved('how much does it pay?', 'how much does it pay?', [])).toBe(false); // nothing to resolve against
  });
});
