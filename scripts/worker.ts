/**
 * BullMQ worker. Run as a separate process when REDIS_URL is configured:
 *   npm run ingest:worker
 * Without Redis the app runs jobs in-process and this worker is unnecessary.
 *
 * Installed as a launchd agent by deploy/install-worker.sh, which starts it
 * at login and restarts it if it crashes.
 */
import 'dotenv/config';
import os from 'node:os';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env, hasRedis } from '../src/lib/env';
import { QUEUE_NAME } from '../src/lib/ingest/queue';
import { failInterruptedUploads, runJob } from '../src/lib/ingest/pipeline';
import { logger } from '../src/lib/logger';
import { failureContext, processDelivery } from '../src/lib/ingest/delivery';

if (!hasRedis()) {
  console.error('REDIS_URL is not set. Jobs run in-process; this worker is not needed.');
  process.exit(1);
}

/**
 * One worker at a time.
 *
 * BullMQ already stops two workers taking the same job, but ingestion writes
 * to shared document rows, and a second worker started by hand — or by a
 * process manager that restarted before the old one exited — would crawl the
 * same sites concurrently. A lease in Redis makes the singleton explicit and
 * expires on its own if this process dies without releasing it.
 */
const LOCK_KEY = `${QUEUE_NAME}:worker-lock`;
const LOCK_TTL_MS = 30_000;
const KEEP_IF_MINE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call(ARGV[2], KEYS[1], ARGV[3]) else return 0 end`;

async function main(): Promise<void> {
  const lockId = `${process.pid}@${os.hostname()}`;
  const redis = new IORedis(env.REDIS_URL!, { maxRetriesPerRequest: null });

  const held = await redis.set(LOCK_KEY, lockId, 'PX', LOCK_TTL_MS, 'NX');
  if (!held) {
    console.error(`Another ingestion worker holds the lock (${await redis.get(LOCK_KEY)}). Exiting.`);
    await redis.quit();
    process.exit(0);
  }

  // Renew while alive; if this process dies the lease lapses and the next
  // worker takes over without manual cleanup.
  const renew = setInterval(() => {
    void redis
      .eval(KEEP_IF_MINE, 1, LOCK_KEY, lockId, 'pexpire', String(LOCK_TTL_MS))
      .catch((err: Error) => logger.warn('Could not renew worker lock', { error: err.message }));
  }, LOCK_TTL_MS / 3);

  // Uploads that died mid-request are never queued, so only a sweep can close them.
  const sweep = () => void failInterruptedUploads().catch((err) => logger.warn('Upload sweep failed', failureContext(undefined, err)));
  sweep();
  const sweeper = setInterval(sweep, 5 * 60_000);

  const worker = new Worker<{ jobId: string }>(
    QUEUE_NAME,
    async (job, token) => {
      logger.info('Worker picked up job', { jobId: job.data.jobId, attempt: job.attemptsMade + 1 });
      await processDelivery(job, token, runJob);
    },
    {
      connection: { url: env.REDIS_URL! },
      concurrency: 1,
      // A crawl holds its job far longer than the 30s default, which would
      // make BullMQ declare it stalled and redeliver it mid-run.
      lockDuration: 5 * 60_000,
      stalledInterval: 60_000,
      // Past this, a job that keeps stalling is failed rather than
      // redelivered forever.
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job) => logger.info('Job completed', { jobId: job.data.jobId }));
  worker.on('failed', (job, err) =>
    logger.error('Job failed', { ...failureContext(job?.data.jobId, err), attemptsMade: job?.attemptsMade }),
  );
  worker.on('error', (err) => logger.error('Worker error', failureContext(undefined, err)));

  console.log(`Worker listening on queue "${QUEUE_NAME}" as ${lockId}…`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, finishing current job…`);
      clearInterval(renew);
      clearInterval(sweeper);
      void worker
        .close()
        // Release only a lease we still own — a lapsed one may be someone else's.
        .then(() => redis.eval(KEEP_IF_MINE, 1, LOCK_KEY, lockId, 'del', ''))
        .then(() => redis.quit())
        .finally(() => process.exit(0));
    });
  }
}

void main().catch((err: unknown) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
