/**
 * BullMQ worker. Run as a separate process when REDIS_URL is configured:
 *   npm run ingest:worker
 * Without Redis the app runs jobs in-process and this worker is unnecessary.
 */
import 'dotenv/config';
import { Worker } from 'bullmq';
import { env, hasRedis } from '../src/lib/env';
import { QUEUE_NAME } from '../src/lib/ingest/queue';
import { runJob } from '../src/lib/ingest/pipeline';
import { logger } from '../src/lib/logger';

if (!hasRedis()) {
  console.error('REDIS_URL is not set. Jobs run in-process; this worker is not needed.');
  process.exit(1);
}

const worker = new Worker<{ jobId: string }>(
  QUEUE_NAME,
  async (job) => {
    logger.info('Worker picked up job', { jobId: job.data.jobId, attempt: job.attemptsMade + 1 });
    await runJob(job.data.jobId);
  },
  { connection: { url: env.REDIS_URL! }, concurrency: 1 },
);

worker.on('completed', (job) => logger.info('Job completed', { jobId: job.data.jobId }));
worker.on('failed', (job, err) =>
  logger.error('Job failed', { jobId: job?.data.jobId, error: err.message }),
);

console.log(`Worker listening on queue "${QUEUE_NAME}"…`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, finishing current job…`);
    await worker.close();
    process.exit(0);
  });
}
