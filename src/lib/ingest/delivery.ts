import { DelayedError, UnrecoverableError } from 'bullmq';
import { JobInFlightError, describeError, errorChain, isPermanentJobError } from './safety';

/** How many times a delivery may be pushed back while its row is owned elsewhere. */
export const MAX_DEFERRALS = 40;
const MIN_DEFER_MS = 30_000;
const MAX_DEFER_MS = 5 * 60_000;

/** The slice of a BullMQ job this handler needs (so it can be tested with a fake). */
export type DeliveryJob = {
  data: { jobId: string; deferrals?: number };
  attemptsMade: number;
  updateData: (data: { jobId: string; deferrals?: number }) => Promise<void>;
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
};

/**
 * Runs one queue delivery and translates the pipeline's outcomes into BullMQ's.
 *
 *  - normal return            → completed
 *  - owned by a live run      → pushed back (DelayedError) without using a retry
 *                               attempt, so it is picked up again once that run
 *                               finishes or its claim goes stale
 *  - permanent input error    → failed immediately, no retries
 *  - anything else            → thrown, so BullMQ retries with backoff
 */
export async function processDelivery(
  job: DeliveryJob,
  token: string | undefined,
  run: (jobId: string) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  try {
    await run(job.data.jobId);
  } catch (err) {
    if (err instanceof JobInFlightError) {
      const deferrals = job.data.deferrals ?? 0;
      if (deferrals >= MAX_DEFERRALS) {
        throw new Error(`Gave up after ${deferrals} deferrals: ${err.message}`);
      }
      const delay = Math.min(MAX_DEFER_MS, Math.max(MIN_DEFER_MS, err.retryAfterMs));
      await job.updateData({ ...job.data, deferrals: deferrals + 1 });
      await job.moveToDelayed(now() + delay, token);
      throw new DelayedError();
    }
    if (isPermanentJobError(err)) throw new UnrecoverableError(describeError(err));
    // BullMQ stores only `err.message` as failedReason; carry the cause chain in it.
    throw new Error(describeError(err), { cause: err });
  }
}

/** Structured failure context for the worker log: the whole cause chain, scrubbed. */
export function failureContext(jobId: string | undefined, err: unknown): Record<string, unknown> {
  return { jobId, error: describeError(err), causes: errorChain(err) };
}
