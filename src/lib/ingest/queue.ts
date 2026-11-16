import { env, hasRedis } from '../env';
import { logger } from '../logger';
import { runJob } from './pipeline';

/**
 * Background job dispatch.
 *
 * With Redis configured, jobs go to a BullMQ queue consumed by a separate
 * worker process (`npm run ingest:worker`). Without Redis, the same job runs
 * in-process, detached from the request, so a local or single-container
 * deployment still works with no extra infrastructure. The API surface is
 * identical either way.
 */

export const QUEUE_NAME = 'gs-ingestion';

type QueueLike = { add: (name: string, data: { jobId: string }) => Promise<unknown> };

let queuePromise: Promise<QueueLike | null> | undefined;

async function getQueue(): Promise<QueueLike | null> {
  if (!hasRedis()) return null;
  queuePromise ??= (async () => {
    try {
      const { Queue } = await import('bullmq');
      const queue = new Queue(QUEUE_NAME, {
        connection: {
          url: env.REDIS_URL!,
          // Fail fast instead of reconnecting forever: if the queue is
          // unreachable we run the job in-process rather than hanging.
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
          enableOfflineQueue: false,
          retryStrategy: (times: number) => (times > 2 ? null : 200),
        },
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
        },
      });
      // Without an error listener an unreachable Redis raises an unhandled
      // error event and takes the request down with it.
      (queue as unknown as { on: (e: string, cb: (err: Error) => void) => void }).on(
        'error',
        (err) => logger.warn('Ingestion queue error; jobs will run in-process', { error: err.message }),
      );

      logger.info('Ingestion queue connected', { queue: QUEUE_NAME });
      return queue as unknown as QueueLike;
    } catch (err) {
      logger.warn('Could not connect to Redis; ingestion will run in-process', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();
  return queuePromise;
}

/** Tracks in-process jobs so a second trigger cannot double-run the same job. */
const running = new Set<string>();

export async function enqueueJob(jobId: string): Promise<{ mode: 'queued' | 'inline' }> {
  const queue = await getQueue();

  if (queue) {
    try {
      await queue.add('run', { jobId });
      return { mode: 'queued' };
    } catch (err) {
      // The connection can drop between constructing the queue and pushing to
      // it, and enableOfflineQueue:false makes that a rejection rather than a
      // wait. The job row already exists, so failing here would strand it as
      // QUEUED forever and block the source's next crawl. Run it in-process.
      logger.warn('Could not push to ingestion queue; running in-process', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (running.has(jobId)) return { mode: 'inline' };
  running.add(jobId);

  // Detached on purpose: the HTTP response returns immediately with the job id,
  // and progress is polled from the ingestion_job row.
  void runJob(jobId)
    .catch((err) =>
      logger.error('Inline ingestion job failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => running.delete(jobId));

  return { mode: 'inline' };
}

export function isRunningInline(jobId: string): boolean {
  return running.has(jobId);
}

/**
 * Whether work is waiting with nothing to consume it.
 *
 * A job sitting at QUEUED is indistinguishable, from the database alone, from
 * one that is about to start. Asking the queue who is listening is what makes
 * "stuck" visible instead of silent.
 */
export async function queueHealth(): Promise<{
  enabled: boolean;
  waiting: number;
  active: number;
  workers: number;
} | null> {
  const queue = (await getQueue()) as
    | (QueueLike & {
        getJobCounts: () => Promise<Record<string, number>>;
        getWorkers: () => Promise<unknown[]>;
      })
    | null;
  if (!queue) return { enabled: false, waiting: 0, active: 0, workers: 0 };

  try {
    const [counts, workers] = await Promise.all([queue.getJobCounts(), queue.getWorkers()]);
    return {
      enabled: true,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      workers: workers.length,
    };
  } catch (err) {
    logger.warn('Could not read ingestion queue health', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
