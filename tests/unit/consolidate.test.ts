import { describe, expect, it } from 'vitest';
import {
  buildCitations,
  checkGrounding,
  deduplicateSources,
  detectConflicts,
  extractCitedIds,
  prioritizeByFreshness,
  reconcileCitations,
  softenOverclaims,
} from '@/lib/rag/consolidate';
import type { RetrievedSource } from '@/types/chat';

function source(overrides: Partial<RetrievedSource> = {}): RetrievedSource {
  return {
    chunkId: 'c1',
    documentId: 'd1',
    title: 'Help for Job Seekers',
    url: 'https://goldensierra.com/help-for-job-seekers',
    snippet: 'Golden Sierra offers tuition assistance and other financial aid.',
    score: 0.8,
    headingPath: null,
    category: 'financial_assistance',
    lastVerified: '2026-11-01T00:00:00.000Z',
    documentType: 'WEB_PAGE',
    used: false,
    ...overrides,
  };
}

describe('deduplicateSources', () => {
  it('drops a near-duplicate passage', () => {
    const text = 'Golden Sierra offers tuition assistance and other financial aid to eligible participants in the region.';
    const result = deduplicateSources([
      source({ chunkId: 'c1', snippet: text }),
      source({ chunkId: 'c2', documentId: 'd2', snippet: `${text} Contact us to learn more.` }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe('c1');
  });

  it('keeps genuinely different passages', () => {
    const result = deduplicateSources([
      source({ chunkId: 'c1', snippet: 'We offer tuition assistance for approved training programs.' }),
      source({
        chunkId: 'c2',
        snippet: 'Employers can receive up to 75% of a new employee gross wages during training.',
      }),
    ]);

    expect(result).toHaveLength(2);
  });
});

describe('detectConflicts', () => {
  it('flags two pages stating different reimbursement rates', () => {
    const conflicts = detectConflicts([
      source({ documentId: 'd1', snippet: 'Receive up to 75% of gross wages during training.' }),
      source({ documentId: 'd2', snippet: 'Receive up to 50% of gross wages during training.' }),
    ]);

    expect(conflicts.some((c) => c.topic === 'reimbursement rate')).toBe(true);
  });

  it('does not flag agreement across pages', () => {
    const conflicts = detectConflicts([
      source({ documentId: 'd1', snippet: 'Call us at (916) 746-7722.' }),
      source({ documentId: 'd2', snippet: 'Our phone number is 916-746-7722.' }),
    ]);

    expect(conflicts.filter((c) => c.topic === 'phone number')).toHaveLength(0);
  });

  it('does not treat silence as disagreement', () => {
    // One page states a figure, the other simply omits it.
    const conflicts = detectConflicts([
      source({ documentId: 'd1', snippet: 'Receive up to 75% of gross wages.' }),
      source({ documentId: 'd2', snippet: 'We help businesses train new employees.' }),
    ]);

    expect(conflicts).toHaveLength(0);
  });

  it('ignores two different values found on the same page', () => {
    const conflicts = detectConflicts([
      source({ documentId: 'd1', snippet: 'Rates range from 50% to 75% of gross wages.' }),
    ]);

    expect(conflicts).toHaveLength(0);
  });
});

describe('citation handling', () => {
  it('extracts single and grouped markers', () => {
    expect(extractCitedIds('Training is available [1]. Scholarships too [2,3].')).toEqual([1, 2, 3]);
  });

  it('removes markers pointing beyond the supplied sources', () => {
    const { answer, citations } = reconcileCitations(
      'Counseling is available [1], and so is funding [9].',
      [source({ chunkId: 'c1' })],
    );

    expect(answer).toContain('[1]');
    expect(answer).not.toContain('[9]');
    expect(citations).toHaveLength(1);
  });

  it('renumbers so visible markers match the source list', () => {
    // The model cited sources 2 and 3 but not 1; the list must start at 1.
    const sources = [
      source({ chunkId: 'c1', documentId: 'd1', title: 'First' }),
      source({ chunkId: 'c2', documentId: 'd2', title: 'Second' }),
      source({ chunkId: 'c3', documentId: 'd3', title: 'Third' }),
    ];
    const { answer, citations } = reconcileCitations('See [2] and [3].', sources);

    expect(answer).toBe('See [1] and [2].');
    expect(citations.map((c) => c.title)).toEqual(['Second', 'Third']);
  });

  it('still shows sources when the model cited nothing', () => {
    const { answer, citations } = reconcileCitations('Training is available.', [source()]);

    expect(answer).toBe('Training is available.');
    expect(citations.length).toBeGreaterThan(0);
  });

  it('builds one citation per document, not per chunk', () => {
    const citations = buildCitations([
      source({ chunkId: 'c1', documentId: 'd1' }),
      source({ chunkId: 'c2', documentId: 'd1' }),
      source({ chunkId: 'c3', documentId: 'd2', title: 'Other' }),
    ]);

    expect(citations).toHaveLength(2);
  });
});

describe('checkGrounding', () => {
  it('flags an asserted eligibility decision', () => {
    const report = checkGrounding('Good news — you qualify for a scholarship.', [source()]);

    expect(report.grounded).toBe(false);
    expect(report.issues.join(' ')).toMatch(/eligibility decision/i);
  });

  it('flags a phone number absent from every source', () => {
    const report = checkGrounding('Call (555) 123-4567 to apply.', [source()]);

    expect(report.grounded).toBe(false);
    expect(report.unsupportedClaims).toContain('(555) 123-4567');
  });

  it('accepts a phone number that appears in the sources, in any format', () => {
    const report = checkGrounding('Call (916) 746-7722.', [
      source({ snippet: 'Phone: 916-746-7722' }),
    ]);

    expect(report.grounded).toBe(true);
  });

  it('flags an invented email address', () => {
    const report = checkGrounding('Email apply@example.com.', [source()]);

    expect(report.grounded).toBe(false);
  });

  it('passes a well-grounded answer', () => {
    const report = checkGrounding(
      'Golden Sierra offers tuition assistance toward approved training [1]. Staff can confirm whether you may be eligible.',
      [source()],
    );

    expect(report.grounded).toBe(true);
    expect(report.issues).toHaveLength(0);
  });
});

describe('softenOverclaims', () => {
  it('rewrites certainty into possibility', () => {
    expect(softenOverclaims('You qualify for this program.')).toBe(
      'You may qualify for this program.',
    );
    expect(softenOverclaims('You will receive $500.')).toBe(
      'You may be able to receive $500.',
    );
    expect(softenOverclaims('You are eligible.')).toBe('You may be eligible.');
  });

  it('leaves already-careful wording alone', () => {
    const careful = 'You may be eligible; staff can confirm.';
    expect(softenOverclaims(careful)).toBe(careful);
  });
});

describe('prioritizeByFreshness', () => {
  it('prefers the more recently verified page when scores are close', () => {
    const result = prioritizeByFreshness([
      source({ chunkId: 'old', score: 0.80, lastVerified: '2024-01-01T00:00:00.000Z' }),
      source({ chunkId: 'new', score: 0.78, lastVerified: '2026-11-01T00:00:00.000Z' }),
    ]);

    expect(result[0]?.chunkId).toBe('new');
  });

  it('does not let recency override a clear relevance gap', () => {
    const result = prioritizeByFreshness([
      source({ chunkId: 'relevant', score: 0.90, lastVerified: '2024-01-01T00:00:00.000Z' }),
      source({ chunkId: 'recent', score: 0.40, lastVerified: '2026-11-01T00:00:00.000Z' }),
    ]);

    expect(result[0]?.chunkId).toBe('relevant');
  });
});
