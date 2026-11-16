import { describe, expect, it } from 'vitest';
import { STAGES, bumpStage, initialProgress, patchStage, readProgress, settleStages } from '@/lib/ingest/progress';
import { sourceKey } from '@/lib/ingest/sources';
import { statusClass } from '@/lib/status';

describe('job progress (real telemetry, never estimated)', () => {
  it('starts with five pending stages and no counts', () => {
    const p = initialProgress();
    expect(STAGES).toEqual(['discover', 'extract', 'chunk', 'embed', 'index']);
    for (const id of STAGES) expect(p.stages[id]).toMatchObject({ state: 'pending', done: 0, total: null, count: 0, errors: 0 });
  });

  it('a stage only starts running when work is actually recorded', () => {
    const p = initialProgress();
    bumpStage(p, 'chunk', { done: 1, count: 7 });
    expect(p.stages.chunk).toMatchObject({ state: 'running', done: 1, count: 7 });
    expect(p.stages.embed.state).toBe('pending');
  });

  it('a total never falls behind the work already done', () => {
    const p = initialProgress();
    patchStage(p, 'index', { total: 2 });
    bumpStage(p, 'index', { done: 3 });
    expect(p.stages.index.total).toBe(3);
  });

  it('settling a successful job completes what ran and skips what never did', () => {
    const p = initialProgress();
    bumpStage(p, 'discover', { done: 3 });
    bumpStage(p, 'extract', { done: 3 });
    settleStages(p, 'completed');
    expect(p.stages.discover.state).toBe('completed');
    expect(p.stages.extract.state).toBe('completed');
    expect(p.stages.chunk.state).toBe('skipped');
    expect(p.stages.index.state).toBe('skipped');
  });

  it('a stage where everything failed ends failed, even in a completed job', () => {
    const p = initialProgress();
    patchStage(p, 'embed', { state: 'running', total: 2 });
    bumpStage(p, 'embed', { errors: 2 });
    settleStages(p, 'completed');
    expect(p.stages.embed.state).toBe('failed');
  });

  it('a failed job fails whatever was running and leaves pending stages pending', () => {
    const p = initialProgress();
    bumpStage(p, 'extract', { done: 1 });
    settleStages(p, 'failed');
    expect(p.stages.extract.state).toBe('failed');
    expect(p.stages.index.state).toBe('pending');
  });

  it('tolerates rows written before progress existed', () => {
    expect(readProgress(null)).toBeNull();
    expect(readProgress({})).toBeNull();
    expect(readProgress({ stages: { discover: {} } })).toBeNull();
    expect(readProgress(initialProgress())).not.toBeNull();
  });
});

describe('sourceKey — one site, one source', () => {
  it.each([
    ['https://goldensierra.com', 'https://www.goldensierra.com/'],
    ['https://goldensierra.com/about/', 'https://goldensierra.com/about'],
    ['https://goldensierra.com/?utm_source=x', 'https://goldensierra.com/#top'],
    ['http://127.0.0.1:4455', 'http://127.0.0.1:4455/'],
  ])('%s and %s are the same source', (a, b) => expect(sourceKey(a)).toBe(sourceKey(b)));

  it.each([
    ['https://goldensierra.com/', 'https://goldensierra.com/about'],
    ['http://127.0.0.1:4455/', 'http://127.0.0.1:4456/'],
    ['https://goldensierra.com/?page=1', 'https://goldensierra.com/?page=2'],
  ])('%s and %s are different sources', (a, b) => expect(sourceKey(a)).not.toBe(sourceKey(b)));

  it('has no key for a missing or unparseable url', () => {
    expect(sourceKey(null)).toBeNull();
    expect(sourceKey('not a url')).toBeNull();
  });
});

describe('status colours for the new states', () => {
  it('paused is a warning, not success or failure', () => {
    expect(statusClass('PAUSED')).toBe('status warn');
    expect(statusClass('paused')).toBe('status warn');
  });
  it('retrieval readiness reuses the success colour only when ready', () => {
    expect(statusClass('ready')).toBe('status done');
    expect(statusClass('partial')).toBe('status warn');
    expect(statusClass('queued')).toBe('status queued');
  });
});
