import { describe, expect, it } from 'vitest';
import { ruleExtract, mergeContext } from '@/lib/counselor/extract';
import { selectNextQuestion, readyForResults, criteriaFor } from '@/lib/counselor/questions';
import { matchPrograms, rankMatches, buildNarrowing, buildKnownFacts, buildAssumptions } from '@/lib/counselor/matching';
import type { CounselorContext, ProgramMatch } from '@/types/counselor';
import type { ProgramRow } from '@/lib/counselor/matching';

/**
 * The counselor's judgement lives in these deterministic pieces — which
 * question to ask, which programs survive, what the panel claims. The model
 * only phrases things, so this is where correctness is actually testable.
 */

const base = (over: Partial<CounselorContext> = {}): CounselorContext => ({
  mode: 'helper',
  population: [],
  barriers: [],
  ...over,
});

function program(over: Partial<ProgramRow> = {}): ProgramRow {
  return {
    id: 'p1', slug: 'training-scholarships', name: 'Training Scholarships',
    shortDescription: 'Tuition assistance toward approved training.',
    description: null, audience: 'job_seeker', categoryId: null, status: 'ACTIVE',
    officialUrl: null, applyUrl: null, contactPhone: null, contactEmail: null,
    nextSteps: null, requiresVerification: true, keywords: [], lastVerifiedAt: null,
    sortOrder: 0, createdAt: new Date(), updatedAt: new Date(),
    category: null, serviceAreas: [], rules: [],
    ...over,
  } as ProgramRow;
}

const area = (county: string) => ({ id: `a-${county}`, programId: 'p1', county, state: 'CA', notes: null });

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', programId: 'p1', field: 'COUNTY', operator: 'IN',
  value: ['Placer', 'El Dorado', 'Alpine'], description: 'Serves the three counties',
  hard: true, sourceUrl: 'https://goldensierra.com/x', verified: true, createdAt: new Date(),
  ...over,
}) as ProgramRow['rules'][number];

// ───────────────────────── extraction ─────────────────────────

describe('ruleExtract', () => {
  it('reads the reference scenario in one message', () => {
    const out = ruleExtract(
      "I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.",
      base(),
    );
    expect(out.age).toBe(19);
    expect(out.ageBand).toBe('18_24');
    expect(out.population).toContain('former_foster_youth');
    expect(out.careerInterest).toMatch(/healthcare/i);
    expect(out.education).toBe('no_hs_diploma');
  });

  it('maps a city to its county', () => {
    const out = ruleExtract('She is staying near Auburn', base());
    expect(out.city).toBe('auburn');
    expect(out.county).toBe('Placer');
  });

  it('reads transport and income urgency', () => {
    expect(ruleExtract('No reliable transport right now', base()).transportation).toBe('none');
    expect(ruleExtract('Public transit only', base()).transportation).toBe('transit_only');
    expect(ruleExtract('She has a car', base()).transportation).toBe('own_vehicle');
    expect(ruleExtract('Needs income as soon as possible', base()).incomeUrgency).toBe('immediate');
    expect(ruleExtract('Can focus on training for a few months', base()).incomeUrgency).toBe('can_train_first');
  });

  it('never extracts identifying details', () => {
    const out = ruleExtract(
      'Her name is Maria Lopez, she lives at 14 Elm Street, phone 916-555-0112, DOB 03/04/2007.',
      base(),
    );
    expect(JSON.stringify(out)).not.toMatch(/Maria|Lopez|Elm|555-0112|03\/04/);
  });

  it('detects veteran and dislocated worker', () => {
    expect(ruleExtract('He is a veteran', base()).population).toContain('veteran');
    expect(ruleExtract('She was laid off when the plant closed', base()).population).toContain('dislocated_worker');
  });
});

describe('mergeContext', () => {
  it('lets a later answer correct an earlier one', () => {
    const merged = mergeContext(base({ county: 'Placer' }), { county: 'El Dorado' });
    expect(merged.county).toBe('El Dorado');
  });

  it('keeps facts the new message did not mention', () => {
    const merged = mergeContext(base({ county: 'Placer', careerInterest: 'healthcare' }), { transportation: 'none' });
    expect(merged.county).toBe('Placer');
    expect(merged.careerInterest).toBe('healthcare');
  });

  it('unions population tags rather than replacing them', () => {
    const merged = mergeContext(base({ population: ['youth'] }), { population: ['former_foster_youth'] });
    expect(merged.population).toEqual(['youth', 'former_foster_youth']);
  });
});

// ───────────────────────── question selection ─────────────────────────

const candidates: ProgramMatch[] = [
  { id: '1', slug: 'job-search-assistance', name: 'Job Search', shortDescription: '', state: 'potential', reasons: [], openQuestions: [], officialUrl: null, contactPhone: null, nextSteps: null, counties: ['Placer'], category: 'Job search' },
  { id: '2', slug: 'training-scholarships', name: 'Scholarships', shortDescription: '', state: 'potential', reasons: [], openQuestions: [], officialUrl: null, contactPhone: null, nextSteps: null, counties: ['Placer', 'Alpine'], category: 'Financial assistance' },
  { id: '3', slug: 'paid-internships', name: 'Internships', shortDescription: '', state: 'needs_verification', reasons: [], openQuestions: [], officialUrl: null, contactPhone: null, nextSteps: null, counties: ['Placer'], category: 'Internships' },
];

describe('selectNextQuestion', () => {
  it('asks exactly one question, never a fixed script', () => {
    const choice = selectNextQuestion(base(), candidates, []);
    expect(choice).not.toBeNull();
    expect(choice!.question.id).toBeTruthy();
  });

  it('never re-asks something already answered', () => {
    const ctx = base({ county: 'Placer' });
    for (let i = 0; i < 6; i++) {
      const choice = selectNextQuestion(ctx, candidates, []);
      if (!choice) break;
      expect(choice.question.id).not.toBe('county');
      break;
    }
  });

  it('never re-asks something already asked', () => {
    const asked = ['county', 'careerInterest', 'education'];
    const choice = selectNextQuestion(base(), candidates, asked);
    if (choice) expect(asked).not.toContain(choice.question.id);
  });

  it('holds back transport until location is known', () => {
    const choice = selectNextQuestion(base(), candidates, ['county', 'audience', 'careerInterest', 'education', 'incomeUrgency', 'employmentStatus', 'age']);
    // With nothing left that is applicable, it must stop rather than ask blindly.
    if (choice) expect(choice.question.id).not.toBe('transportation');
  });

  it('asks transport once a county is known', () => {
    const ctx = base({ county: 'Placer', careerInterest: 'healthcare', education: 'no_hs_diploma', age: 19 });
    const choice = selectNextQuestion(ctx, candidates, ['audience', 'incomeUrgency', 'employmentStatus']);
    expect(choice?.question.id).toBe('transportation');
  });

  it('stops asking when everything useful is known — no infinite loop', () => {
    const ctx = base({
      county: 'Placer', city: 'auburn', careerInterest: 'healthcare', education: 'no_hs_diploma',
      age: 19, transportation: 'none', incomeUrgency: 'immediate', employmentStatus: 'unemployed',
      audience: 'job_seeker', population: ['former_foster_youth'],
    });
    expect(selectNextQuestion(ctx, candidates, [])).toBeNull();
  });

  it('phrases questions for the right subject', () => {
    const helper = selectNextQuestion(base({ mode: 'helper' }), candidates, []);
    const self = selectNextQuestion(base({ mode: 'self' }), candidates, []);
    expect(helper!.question.prompt('helper', base({ mode: 'helper' }))).toMatch(/they|their/i);
    expect(self!.question.prompt('self', base({ mode: 'self' }))).toMatch(/you|your/i);
  });
});

describe('readyForResults', () => {
  it('is false at the very start', () => {
    expect(readyForResults(base(), candidates)).toBe(false);
  });

  it('still waits while a decisive question is unanswered', () => {
    // County is known, so transport is now worth asking — and transport
    // changes the shortlist more than anything else. Three known dimensions
    // is not a licence to stop asking.
    const ctx = base({ county: 'Placer', careerInterest: 'healthcare', incomeUrgency: 'immediate' });
    expect(readyForResults(ctx, candidates, [])).toBe(false);
  });

  it('is ready once the decisive questions are covered', () => {
    const ctx = base({
      county: 'Placer', careerInterest: 'healthcare',
      incomeUrgency: 'immediate', transportation: 'none',
    });
    expect(readyForResults(ctx, candidates, [])).toBe(true);
  });

  it('keeps waiting when a decisive question was asked but sidestepped', () => {
    const ctx = base({ county: 'Placer', careerInterest: 'healthcare' });
    // Asked once, answered neither — people often reply to something else.
    expect(readyForResults(ctx, candidates, ['transportation', 'incomeUrgency'])).toBe(false);
  });

  it('stops waiting after a second unanswered ask, so it cannot loop', () => {
    const ctx = base({ county: 'Placer', careerInterest: 'healthcare' });
    const asked = ['transportation', 'incomeUrgency', 'transportation', 'incomeUrgency'];
    expect(readyForResults(ctx, candidates, asked)).toBe(true);
  });
});

// ───────────────────────── matching ─────────────────────────

describe('matchPrograms', () => {
  it('keeps an untestable program as needs_verification rather than excluding it', () => {
    const [m] = matchPrograms([program({ rules: [rule({ field: 'INCOME_LEVEL', operator: 'LTE', value: 40000 })] })], base());
    expect(m!.state).toBe('needs_verification');
    expect(m!.openQuestions.length).toBeGreaterThan(0);
  });

  it('excludes only on a contradicted hard verified rule', () => {
    const p = program({ serviceAreas: [area('Alpine')] });
    const [m] = matchPrograms([p], base({ county: 'Placer' }));
    expect(m!.state).toBe('mismatch');
  });

  it('confirms a met geographic rule', () => {
    const p = program({ serviceAreas: [area('Placer')] });
    const [m] = matchPrograms([p], base({ county: 'Placer' }));
    expect(m!.state).not.toBe('mismatch');
    expect(m!.reasons.join(' ')).toMatch(/Placer/);
  });

  it('never lets an unverified rule exclude anyone', () => {
    const p = program({ rules: [rule({ verified: false, value: ['Alpine'] })] });
    const [m] = matchPrograms([p], base({ county: 'Placer' }));
    expect(m!.state).not.toBe('mismatch');
  });

  it('routes employer services away from job seekers', () => {
    const p = program({ audience: 'employer' });
    const [m] = matchPrograms([p], base({ audience: 'job_seeker' }));
    expect(m!.state).toBe('mismatch');
  });

  it('flags GED prerequisites rather than excluding training', () => {
    const [m] = matchPrograms([program()], base({ education: 'no_hs_diploma' }));
    expect(m!.state).not.toBe('mismatch');
    expect(m!.openQuestions.join(' ')).toMatch(/diploma or GED/i);
  });

  it('drops mismatches from the ranked list', () => {
    const ranked = rankMatches(matchPrograms(
      [program({ serviceAreas: [area('Alpine')] }), program({ id: 'p2', serviceAreas: [area('Placer')] })],
      base({ county: 'Placer' }),
    ));
    expect(ranked).toHaveLength(1);
  });
});

// ───────────────────────── panel honesty ─────────────────────────

describe('buildNarrowing', () => {
  it('never invents a total when the catalogue is unavailable', () => {
    const n = buildNarrowing(base(), [], null);
    expect(n.total).toBeNull();
    expect(n.candidates).toBeNull();
    expect(n.explanation).toMatch(/Searching available workforce resources/);
  });

  it('reports real counts from real matches', () => {
    const matches = matchPrograms(
      [program({ serviceAreas: [area('Placer')] }), program({ id: 'p2', serviceAreas: [area('Alpine')] })],
      base({ county: 'Placer' }),
    );
    const n = buildNarrowing(base({ county: 'Placer' }), matches, 2);
    expect(n.total).toBe(2);
    expect(n.candidates).toBe(1);
  });
});

describe('buildKnownFacts', () => {
  it('reflects the reference scenario in the panel', () => {
    const ctx = base({
      population: ['former_foster_youth'], careerInterest: 'healthcare',
      education: 'no_hs_diploma', city: 'auburn', county: 'Placer', transportation: 'none',
    });
    const labels = buildKnownFacts(ctx, 'Income urgency').map((f) => `${f.label}|${f.dimension}|${f.state}`);
    expect(labels.some((l) => /Former foster youth\|Population\|known/.test(l))).toBe(true);
    expect(labels.some((l) => /Healthcare\|Career pathway\|known/.test(l))).toBe(true);
    expect(labels.some((l) => /GED.*\|Service type\|known/.test(l))).toBe(true);
    expect(labels.some((l) => /Auburn.*no transport\|Geography\|known/.test(l))).toBe(true);
    expect(labels.some((l) => /Income urgency\|Waiting on answer\|pending/.test(l))).toBe(true);
  });
});

describe('buildAssumptions', () => {
  it('surfaces the youth assumption without asserting eligibility', () => {
    const a = buildAssumptions(base({ age: 19, population: ['former_foster_youth'] }), []);
    expect(a).not.toBeNull();
    expect(a!.text).toMatch(/may qualify/i);
    expect(a!.text).not.toMatch(/\bis eligible\b|\bqualifies\b/i);
  });

  it('explains a transport-driven narrowing', () => {
    const a = buildAssumptions(base({ transportation: 'none', county: 'Placer', city: 'auburn' }), []);
    expect(a!.text).toMatch(/Auburn/i);
  });
});

describe('criteriaFor', () => {
  it('marks only what is actually known', () => {
    const c = criteriaFor(base({ county: 'Placer' }));
    expect(c.find((x) => x.key === 'county')!.applied).toBe(true);
    expect(c.find((x) => x.key === 'incomeUrgency')!.applied).toBe(false);
  });
});
