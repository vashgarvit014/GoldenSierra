/**
 * Real, per-stage ingestion telemetry.
 *
 * Every number here is incremented by the code that did the work — a page was
 * extracted, a document was chunked, vectors were written — never estimated
 * from elapsed time. A stage that has not started is `pending`; one with
 * nothing to do is `skipped`.
 */

export const STAGES = ['discover', 'extract', 'chunk', 'embed', 'index'] as const;
export type StageId = (typeof STAGES)[number];
export type StageState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type StageProgress = {
  state: StageState;
  /** Units finished: URLs found, pages extracted, documents chunked/embedded/indexed. */
  done: number;
  /** Units expected, when known. */
  total: number | null;
  /** Secondary count: chunks created, vectors embedded, vectors written. */
  count: number;
  /** Units that failed. */
  errors: number;
};

export type JobProgress = { stages: Record<StageId, StageProgress>; updatedAt: string };

export function initialProgress(): JobProgress {
  const stage = (): StageProgress => ({ state: 'pending', done: 0, total: null, count: 0, errors: 0 });
  return {
    stages: { discover: stage(), extract: stage(), chunk: stage(), embed: stage(), index: stage() },
    updatedAt: new Date().toISOString(),
  };
}

export function patchStage(progress: JobProgress, id: StageId, patch: Partial<StageProgress>): void {
  const stage = progress.stages[id];
  Object.assign(stage, patch);
  // A total is a promise about the future; never let `done` outrun it.
  if (stage.total !== null && stage.done > stage.total) stage.total = stage.done;
  progress.updatedAt = new Date().toISOString();
}

/** Adds to a stage's counters, starting it if it was pending. */
export function bumpStage(
  progress: JobProgress,
  id: StageId,
  by: { done?: number; count?: number; errors?: number },
): void {
  const stage = progress.stages[id];
  patchStage(progress, id, {
    state: stage.state === 'pending' ? 'running' : stage.state,
    done: stage.done + (by.done ?? 0),
    count: stage.count + (by.count ?? 0),
    errors: stage.errors + (by.errors ?? 0),
  });
}

/** Ends every stage still running: completed, or failed when everything it touched failed. */
export function settleStages(progress: JobProgress, outcome: 'completed' | 'failed'): void {
  for (const id of STAGES) {
    const stage = progress.stages[id];
    if (stage.state === 'running') {
      const allFailed = stage.errors > 0 && stage.errors >= Math.max(stage.done, stage.total ?? 0);
      patchStage(progress, id, { state: outcome === 'failed' || allFailed ? 'failed' : 'completed' });
    } else if (stage.state === 'pending' && outcome === 'completed') {
      patchStage(progress, id, { state: 'skipped' });
    }
  }
}

/** Tolerant reader for the JSON column (old rows have none). */
export function readProgress(value: unknown): JobProgress | null {
  if (!value || typeof value !== 'object') return null;
  const stages = (value as { stages?: Record<string, unknown> }).stages;
  if (!stages) return null;
  for (const id of STAGES) if (!stages[id] || typeof stages[id] !== 'object') return null;
  return value as JobProgress;
}
