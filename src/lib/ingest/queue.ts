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
        connection: { url: env.REDIS_URL! },
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
        },
      });
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
    await queue.add('run', { jobId });
    return { mode: 'queued' };
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
