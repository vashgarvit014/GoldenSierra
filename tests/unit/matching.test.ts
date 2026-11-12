import { describe, expect, it } from 'vitest';
import { RuleField, RuleOperator } from '@prisma/client';
import { matchPrograms, toRecommendations } from '@/lib/programs/matching';
import type { ProgramRecord } from '@/lib/rag/retrieve';
import type { QueryAnalysis, RetrievedSource, UserProfile } from '@/types/chat';

function program(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'A Program',
    shortDescription: 'Does something useful.',
    description: null,
    audience: 'job_seeker',
    categoryId: 'cat-1',
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
    category: {
      id: 'cat-1',
      slug: 'training',
      name: 'Training & classes',
      description: null,
      audience: 'job_seeker',
      sortOrder: 1,
    },
    serviceAreas: [],
    rules: [],
    documents: [],
    ...overrides,
  } as ProgramRecord;
}

const analysis: QueryAnalysis = {
  intent: 'find_training',
  confidence: 0.8,
  rewrittenQuery: 'training options',
  keywords: [],
  profileUpdates: {},
  missingInfo: null,
  isMultiPart: false,
  subQuestions: [],
};

const noSources: RetrievedSource[] = [];

describe('matchPrograms', () => {
  it('ranks a program matching the intent category', () => {
    const matches = matchPrograms(
      [program({ id: 'fit', slug: 'fit' }), program({ id: 'other', slug: 'other', categoryId: 'cat-2', category: null })],
      analysis,
      {},
      noSources,
    );

    expect(matches[0]?.program.slug).toBe('fit');
  });

  it('drops a program not offered in the user county', () => {
    const matches = matchPrograms(
      [
        program({
          slug: 'alpine-only',
          serviceAreas: [{ id: 'a', programId: 'p1', county: 'Alpine', state: 'CA', notes: null }],
        }),
      ],
      analysis,
      { county: 'Placer' },
      noSources,
    );

    expect(matches).toHaveLength(0);
  });

  it('does not surface a veterans-only program to someone who never mentioned service', () => {
    // Regression: the eligibility engine correctly declines to *exclude* an
    // unknown, but an unasked-for veterans program must not be recommended.
    const veterans = program({
      id: 'vets',
      slug: 'veterans-priority',
      name: 'Veterans Priority of Service',
      rules: [
        {
          id: 'r1',
          programId: 'vets',
          field: RuleField.VETERAN_STATUS,
          operator: RuleOperator.EQUALS,
          value: true as never,
          description: 'Applies to veterans and eligible spouses',
          hard: true,
          sourceUrl: 'https://goldensierra.com/help-for-job-seekers',
          verified: true,
          createdAt: new Date(),
        },
      ],
    });

    const matches = matchPrograms([veterans], analysis, { county: 'Placer' }, noSources);
    expect(matches.map((m) => m.program.slug)).not.toContain('veterans-priority');
  });

  it('does surface it once the person says they are a veteran', () => {
    const veterans = program({
      id: 'vets',
      slug: 'veterans-priority',
      name: 'Veterans Priority of Service',
      keywords: ['veteran'],
      rules: [
        {
          id: 'r1',
          programId: 'vets',
          field: RuleField.VETERAN_STATUS,
          operator: RuleOperator.EQUALS,
          value: true as never,
          description: 'Applies to veterans and eligible spouses',
          hard: true,
          sourceUrl: 'https://goldensierra.com/help-for-job-seekers',
          verified: true,
          createdAt: new Date(),
        },
      ],
    });

    const matches = matchPrograms([veterans], analysis, { county: 'Placer', isVeteran: true }, noSources);
    expect(matches.map((m) => m.program.slug)).toContain('veterans-priority');
  });

  it('still recommends programs whose only untested rule is county', () => {
    // County being unknown must not suppress everything — most users never
    // state a county, and the agency serves all three anyway.
    const matches = matchPrograms(
      [
        program({
          slug: 'general-training',
          rules: [
            {
              id: 'r1',
              programId: 'p1',
              field: RuleField.COUNTY,
              operator: RuleOperator.IN,
              value: ['Placer', 'El Dorado', 'Alpine'] as never,
              description: 'Serves the three counties',
              hard: true,
              sourceUrl: 'https://goldensierra.com/help-for-job-seekers',
              verified: true,
              createdAt: new Date(),
            },
          ],
        }),
      ],
      analysis,
      {},
      noSources,
    );

    expect(matches.map((m) => m.program.slug)).toContain('general-training');
  });

  it('penalises an employer program when the user is a job seeker', () => {
    const matches = matchPrograms(
      [
        program({ slug: 'seeker', audience: 'job_seeker' }),
        program({ id: 'p2', slug: 'employer', audience: 'employer' }),
      ],
      analysis,
      { audience: 'job_seeker' } as UserProfile,
      noSources,
    );

    expect(matches[0]?.program.slug).toBe('seeker');
  });

  it('lifts a program whose supporting document was actually retrieved', () => {
    const linked = program({
      id: 'linked',
      slug: 'linked',
      documents: [{ programId: 'linked', documentId: 'doc-1' } as never],
    });
    const unlinked = program({ id: 'unlinked', slug: 'unlinked' });

    const sources: RetrievedSource[] = [
      {
        chunkId: 'c1',
        documentId: 'doc-1',
        title: 'Page',
        url: null,
        snippet: 'Content',
        score: 0.8,
        headingPath: null,
        category: 'training',
        lastVerified: null,
        documentType: 'WEB_PAGE',
        used: true,
      },
    ];

    const matches = matchPrograms([unlinked, linked], analysis, {}, sources);
    expect(matches[0]?.program.slug).toBe('linked');
  });
});

describe('toRecommendations', () => {
  it('never exposes an unverified eligibility rule', () => {
    const withRules = program({
      rules: [
        {
          id: 'r1',
          programId: 'p1',
          field: RuleField.COUNTY,
          operator: RuleOperator.IN,
          value: ['Placer'] as never,
          description: 'Verified and sourced',
          hard: true,
          sourceUrl: 'https://goldensierra.com/x',
          verified: true,
          createdAt: new Date(),
        },
        {
          id: 'r2',
          programId: 'p1',
          field: RuleField.OTHER,
          operator: RuleOperator.EXISTS,
          value: null as never,
          description: 'Unverified guess that must not be shown',
          hard: false,
          sourceUrl: null,
          verified: false,
          createdAt: new Date(),
        },
      ],
    });

    const matches = matchPrograms([withRules], analysis, { county: 'Placer' }, noSources);
    const [recommendation] = toRecommendations(matches);

    const descriptions = recommendation?.eligibility.map((e) => e.description) ?? [];
    expect(descriptions).toContain('Verified and sourced');
    expect(descriptions).not.toContain('Unverified guess that must not be shown');
  });

  it('caps the number of recommendations', () => {
    const programs = Array.from({ length: 10 }, (_, i) =>
      program({ id: `p${i}`, slug: `p${i}`, name: `Program ${i}` }),
    );
    expect(toRecommendations(matchPrograms(programs, analysis, {}, noSources), 4)).toHaveLength(4);
  });
});
