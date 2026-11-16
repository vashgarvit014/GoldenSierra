import { describe, expect, it } from 'vitest';
import { statusClass } from '@/lib/status';

describe('statusClass', () => {
  it('gives queued, running, completed and failed four different looks', () => {
    const classes = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'].map(statusClass);
    expect(new Set(classes).size).toBe(4);
  });

  it('never presents a failure as a success, or the reverse', () => {
    expect(statusClass('FAILED')).toContain('failed');
    expect(statusClass('FAILED')).not.toContain('done');
    expect(statusClass('COMPLETED')).toContain('done');
    expect(statusClass('COMPLETED')).not.toContain('failed');
  });

  it('treats an unknown state as neutral rather than as success', () => {
    expect(statusClass('SOMETHING_NEW')).toBe('status queued');
  });

  it('keeps documents on the same scale as jobs', () => {
    expect(statusClass('INDEXED')).toBe(statusClass('COMPLETED'));
  });
});
