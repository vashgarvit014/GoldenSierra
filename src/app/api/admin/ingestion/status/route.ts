import { NextResponse } from 'next/server';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withErrorHandling } from '@/lib/errors';
import { requireAdmin } from '@/lib/auth';
import { auditIndex, failInterruptedUploads } from '@/lib/ingest/pipeline';
import { collectionStats } from '@/lib/vector/qdrant';
import { queueHealth } from '@/lib/ingest/queue';
import { readProgress } from '@/lib/ingest/progress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/ingestion/status — job progress plus index health. */
export const GET = withErrorHandling(async (request: Request) => {
  await requireAdmin(AdminRole.VIEWER);
  const jobId = new URL(request.url).searchParams.get('jobId');

  if (jobId) {
    const job = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      include: { source: { select: { name: true } } },
    });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    return NextResponse.json({ job: serializeJob(job) });
  }

  // Idempotent housekeeping: an upload whose request died would otherwise show RUNNING forever.
  await failInterruptedUploads().catch(() => 0);

  const [jobs, vector, index, queue] = await Promise.all([
    prisma.ingestionJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { source: { select: { name: true } } },
    }),
    collectionStats(),
    auditIndex(),
    queueHealth(),
  ]);

  return NextResponse.json({
    jobs: jobs.map(serializeJob),
    vector,
    index,
    queue,
  });
});

type JobRow = Awaited<ReturnType<typeof prisma.ingestionJob.findMany>>[number] & {
  source?: { name: string } | null;
};

function serializeJob(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    sourceName: job.source?.name ?? null,
    pagesDiscovered: job.pagesDiscovered,
    pagesProcessed: job.pagesProcessed,
    documentsCreated: job.documentsCreated,
    documentsUpdated: job.documentsUpdated,
    documentsSkipped: job.documentsSkipped,
    chunksIndexed: job.chunksIndexed,
    errorCount: job.errorCount,
    error: job.error,
    log: job.log,
    progress: readProgress(job.progress),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}
