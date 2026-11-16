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

import { checkCrawlHost, explainHostRejection, isHostAllowed } from '@/lib/ingest/crawler';

describe('crawl host allowlist', () => {
  const GS = ['goldensierra.com', 'www.goldensierra.com'];
  const ok = (url: string, list: string[] = GS) => checkCrawlHost(url, list).ok;

  it.each([
    'https://goldensierra.com/',
    'https://www.goldensierra.com',
    'http://goldensierra.com/about/',
    'https://GoldenSierra.COM/About',
    'https://goldensierra.com:443/',
    'https://goldensierra.com./',
    'https://jobs.goldensierra.com/',
  ])('accepts %s', (url) => expect(ok(url)).toBe(true));

  it.each([
    'https://goldensierra.org/',
    'https://evilgoldensierra.com/',
    'https://goldensierra.com.evil.com/',
    'https://goldensierra.com@evil.com/',
    'https://evil.com/?u=goldensierra.com',
    'https://127.0.0.1/',
  ])('rejects %s', (url) => expect(ok(url)).toBe(false));

  it('the configured allowlist is what the app really loads', () => {
    expect(isHostAllowed('https://goldensierra.com/')).toBe(true);
  });

  it('a www-only entry does not authorize the bare domain', () => {
    expect(ok('https://goldensierra.com/', ['www.goldensierra.com'])).toBe(false);
  });

  it('the rejection names the exact host, the allowed list, and the fix', () => {
    const v = checkCrawlHost('https://golden-sierra.org/jobs', GS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const text = explainHostRejection(v);
    expect(v).toMatchObject({ host: 'golden-sierra.org', reason: 'not_listed' });
    expect(text).toContain('"golden-sierra.org"');
    expect(text).toContain('goldensierra.com, www.goldensierra.com');
    expect(text).toContain('CRAWL_ALLOWED_HOSTS');
  });

  it('suggests the likely intended host for a typo', () => {
    const v = checkCrawlHost('https://goldensiera.com/', GS);
    expect(v.ok === false && v.suggestion).toBe('goldensierra.com');
    const other = checkCrawlHost('https://goldensiera.org/jobs', GS); // wrong TLD as well
    expect(other.ok === false && other.suggestion).toBe('goldensierra.com');
    const unrelated = checkCrawlHost('https://example.com/', GS);
    expect(unrelated.ok === false && unrelated.suggestion).toBeUndefined();
  });

  it('distinguishes an unparseable URL and a bad scheme from an unlisted host', () => {
    expect(checkCrawlHost('goldensierra.com', GS)).toMatchObject({ ok: false, reason: 'invalid_url' });
    expect(checkCrawlHost('ftp://goldensierra.com/', GS)).toMatchObject({ ok: false, reason: 'bad_scheme' });
  });
});
