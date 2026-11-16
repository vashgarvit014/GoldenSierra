import { describe, expect, it } from 'vitest';
import { detectAudience } from '@/lib/ingest/clean';

describe('detectAudience — success stories are for participants', () => {
  const story = 'Erin connected with Golden Sierra at a career fair. She received help paying for textbooks and a digital pen.';
  it('classifies /impact stories as job_seeker', () => {
    expect(detectAudience('https://goldensierra.com/impact/erins-success-story', 'Erin’s Success Story', story)).toBe('job_seeker');
    expect(detectAudience('https://goldensierra.com/impact', 'Impact', story)).toBe('job_seeker');
  });
  it('classifies a titled success story anywhere as job_seeker', () => {
    expect(detectAudience('https://example.test/p/1', 'Nico’s Success Story', story)).toBe('job_seeker');
  });
  it('still sends governance pages to agency', () => {
    expect(detectAudience('https://goldensierra.com/workforce-board', 'Board', story)).toBe('agency');
  });
  it('does not widen employer content', () => {
    expect(detectAudience('https://goldensierra.com/help-for-employers/x', 'On-the-job training wage reimbursement', 'hiring recruit layoff')).toBe('employer');
  });
});
