/**
 * Ingestion worker:
 *   npm run ingest:worker
 * Consumes the BullMQ queue when REDIS_URL is set, and in every case polls the database for
 * QUEUED jobs — which is how jobs arrive from a serverless app (INGESTION_RUNNER=worker) that
 * cannot reach Redis. Jobs run one at a time; runJob's compare-and-set claim makes a job that
 * arrives by both routes run once.
 *
 * Installed as a launchd agent by deploy/install-worker.sh, which starts it
 * at login and restarts it if it crashes.
 */
import 'dotenv/config';
import os from 'node:os';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env, hasRedis } from '../src/lib/env';
import { JobStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { QUEUE_NAME, WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_MS } from '../src/lib/ingest/queue';
import { failInterruptedUploads, runJob } from '../src/lib/ingest/pipeline';
import { logger } from '../src/lib/logger';
import { failureContext, processDelivery } from '../src/lib/ingest/delivery';

/** One job at a time across both delivery routes. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const POLL_MS = 5_000;

/** Claims QUEUED rows straight from the database, oldest first. */
function startDatabasePolling(): () => void {
  let stopped = false;
  let idle = true;
  const tick = async () => {
    if (stopped || !idle) return;
    idle = false;
    // A job still QUEUED after a run attempt (it failed before its claim) waits for the next tick
    // instead of spinning this loop.
    const tried = new Set<string>();
    try {
      for (;;) {
        const next = await prisma.ingestionJob.findFirst({
          where: { status: JobStatus.QUEUED, id: { notIn: [...tried] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!next || stopped) break;
        tried.add(next.id);
        logger.info('Worker picked up job from the database', { jobId: next.id });
        await serial(() => runJob(next.id)).catch((err) =>
          logger.error('Job failed', failureContext(next.id, err)),
        );
      }
    } catch (err) {
      logger.warn('Database poll failed', failureContext(undefined, err));
    } finally {
      idle = true;
    }
  };
  const beat = () =>
    void prisma.systemConfig
      .upsert({
        where: { key: WORKER_HEARTBEAT_KEY },
        create: { key: WORKER_HEARTBEAT_KEY, value: { host: os.hostname() }, description: 'Ingestion worker liveness' },
        update: { value: { host: os.hostname(), at: new Date().toISOString() } },
      })
      .catch((err: Error) => logger.warn('Could not write worker heartbeat', { error: err.message }));
  beat();
  void tick();
  const poller = setInterval(() => void tick(), POLL_MS);
  const beater = setInterval(beat, WORKER_HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(poller);
    clearInterval(beater);
  };
}

async function mainWithoutRedis(): Promise<void> {
  const sweep = () => void failInterruptedUploads().catch((err) => logger.warn('Upload sweep failed', failureContext(undefined, err)));
  sweep();
  const sweeper = setInterval(sweep, 5 * 60_000);
  const stop = startDatabasePolling();
  console.log('Worker polling the database for queued jobs (no REDIS_URL)…');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, finishing current job…`);
      stop();
      clearInterval(sweeper);
      void chain.finally(() => prisma.$disconnect()).finally(() => process.exit(0));
    });
  }
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
      await serial(() => processDelivery(job, token, runJob));
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

  const stopPolling = startDatabasePolling();
  console.log(`Worker listening on queue "${QUEUE_NAME}" and polling the database as ${lockId}…`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, finishing current job…`);
      clearInterval(renew);
      clearInterval(sweeper);
      stopPolling();
      void worker
        .close()
        // Release only a lease we still own — a lapsed one may be someone else's.
        .then(() => redis.eval(KEEP_IF_MINE, 1, LOCK_KEY, lockId, 'del', ''))
        .then(() => redis.quit())
        .finally(() => process.exit(0));
    });
  }
}

void (hasRedis() ? main() : mainWithoutRedis()).catch((err: unknown) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
