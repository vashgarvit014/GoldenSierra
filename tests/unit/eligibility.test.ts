import { describe, expect, it } from 'vitest';
import { RuleField, RuleOperator } from '@prisma/client';
import { evaluateProgram, servesCounty } from '@/lib/programs/eligibility';
import type { ProgramRecord } from '@/lib/rag/retrieve';
import type { UserProfile } from '@/types/chat';

/**
 * The eligibility engine decides what the assistant is allowed to imply about
 * whether someone qualifies. These tests exist because the failure mode is
 * invisible and consequential: an answer that wrongly says "you qualify" looks
 * exactly like one that is right.
 */

type Rule = ProgramRecord['rules'][number];

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    programId: 'prog-1',
    field: RuleField.COUNTY,
    operator: RuleOperator.IN,
    value: ['Placer', 'El Dorado', 'Alpine'] as never,
    description: 'Serves Placer, El Dorado and Alpine counties',
    hard: true,
    sourceUrl: 'https://goldensierra.com/help-for-job-seekers',
    verified: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function program(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 'prog-1',
    slug: 'test-program',
    name: 'Test Program',
    shortDescription: 'A program',
    description: null,
    audience: 'job_seeker',
    categoryId: null,
    status: 'ACTIVE',
    officialUrl: null,
    applyUrl: null,
    contactPhone: null,
    contactEmail: null,
    nextSteps: null,
    requiresVerification: false,
    keywords: [],
    lastVerifiedAt: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: null,
    serviceAreas: [],
    rules: [],
    documents: [],
    ...overrides,
  } as ProgramRecord;
}

describe('evaluateProgram', () => {
  it('marks a rule met when the stated facts satisfy it', () => {
    const result = evaluateProgram(program({ rules: [rule()] }), { county: 'Placer' });

    expect(result.met).toHaveLength(1);
    expect(result.exclusions).toHaveLength(0);
    expect(result.possiblyEligible).toBe(true);
  });

  it('excludes only on a hard, verified, contradicted rule', () => {
    const result = evaluateProgram(
      program({ rules: [rule()] }),
      { county: 'Sacramento' as UserProfile['county'] },
    );

    expect(result.possiblyEligible).toBe(false);
    expect(result.exclusions).toHaveLength(1);
  });

  it('treats an unverified rule as undecidable, never as an exclusion', () => {
    // An unsourced rule must not be able to turn anybody away.
    const result = evaluateProgram(
      program({ rules: [rule({ verified: false, sourceUrl: null })] }),
      { county: 'Sacramento' as UserProfile['county'] },
    );

    expect(result.possiblyEligible).toBe(true);
    expect(result.unknowns).toHaveLength(1);
    expect(result.exclusions).toHaveLength(0);
  });

  it('does not exclude on a soft rule, even when contradicted', () => {
    const result = evaluateProgram(
      program({
        rules: [rule({ field: RuleField.AGE, operator: RuleOperator.BETWEEN, value: [16, 24] as never, hard: false })],
      }),
      { ageBand: '25_54' },
    );

    expect(result.possiblyEligible).toBe(true);
    expect(result.exclusions).toHaveLength(0);
  });

  it('returns unknown when the user has stated nothing relevant', () => {
    const result = evaluateProgram(program({ rules: [rule()] }), {});

    expect(result.unknowns).toHaveLength(1);
    expect(result.met).toHaveLength(0);
    expect(result.requiresVerification).toBe(true);
  });

  it('never resolves income, because income is never collected', () => {
    const result = evaluateProgram(
      program({
        rules: [
          rule({ field: RuleField.INCOME_LEVEL, operator: RuleOperator.LTE, value: 50_000 as never }),
        ],
      }),
      {},
    );

    expect(result.unknowns).toHaveLength(1);
    expect(result.evaluations[0]?.outcome).toBe('unknown');
  });

  it('requires verification whenever any rule is untested', () => {
    const result = evaluateProgram(
      program({ rules: [rule(), rule({ id: 'rule-2', field: RuleField.VETERAN_STATUS, operator: RuleOperator.EQUALS, value: true as never })] }),
      { county: 'Placer' },
    );

    expect(result.met).toHaveLength(1);
    expect(result.unknowns).toHaveLength(1);
    expect(result.requiresVerification).toBe(true);
  });

  it('honours a program-level verification requirement even when all rules pass', () => {
    const result = evaluateProgram(
      program({ rules: [rule()], requiresVerification: true }),
      { county: 'Placer' },
    );

    expect(result.possiblyEligible).toBe(true);
    expect(result.requiresVerification).toBe(true);
  });

  it('evaluates numeric boundaries inclusively', () => {
    const between = (band: UserProfile['ageBand']) =>
      evaluateProgram(
        program({
          rules: [rule({ field: RuleField.AGE, operator: RuleOperator.BETWEEN, value: [18, 24] as never })],
        }),
        { ageBand: band },
      );

    expect(between('18_24').met).toHaveLength(1);
    expect(between('55_plus').exclusions).toHaveLength(1);
  });
});

describe('servesCounty', () => {
  it('treats a program with no recorded service area as agency-wide', () => {
    expect(servesCounty(program(), 'Placer')).toBe('unknown');
  });

  it('confirms a match and rejects a non-match', () => {
    const withArea = program({
      serviceAreas: [
        { id: 'a', programId: 'prog-1', county: 'Placer', state: 'CA', notes: null },
      ],
    });
    expect(servesCounty(withArea, 'Placer')).toBe('yes');
    expect(servesCounty(withArea, 'Alpine')).toBe('no');
  });

  it('is unknown when the user has not said where they live', () => {
    const withArea = program({
      serviceAreas: [{ id: 'a', programId: 'prog-1', county: 'Placer', state: 'CA', notes: null }],
    });
    expect(servesCounty(withArea, undefined)).toBe('unknown');
  });
});
