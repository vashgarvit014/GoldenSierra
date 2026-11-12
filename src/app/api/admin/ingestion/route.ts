import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, JobStatus, JobType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { createJob } from '@/lib/ingest/pipeline';
import { enqueueJob } from '@/lib/ingest/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Ingestion can run long when Redis is absent and the job executes in-process.
export const maxDuration = 300;

const BodySchema = z.object({
  type: z.enum(['CRAWL', 'REINDEX', 'PDF_INGEST', 'FULL_REBUILD']),
  sourceId: z.string().min(1).optional(),
  url: z.string().url().max(2000).optional(),
  documentIds: z.array(z.string().min(1)).max(500).optional(),
});

/** POST /api/admin/ingestion — queue a crawl, re-index, or PDF ingest. */
export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.EDITOR);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = BodySchema.parse(json);

  if (body.type === 'CRAWL') {
    if (!body.sourceId) throw badRequest('A sourceId is required to start a crawl');
    const source = await prisma.knowledgeSource.findUnique({ where: { id: body.sourceId } });
    if (!source) throw notFound('Source not found');
    if (!source.rootUrl) throw badRequest('This source has no root URL to crawl');

    // Refuse to stack crawls on one source — concurrent crawls of the same
    // site race each other on the same document rows.
    const active = await prisma.ingestionJob.findFirst({
      where: {
        sourceId: source.id,
        status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
      },
    });
    if (active) {
      throw badRequest(`A crawl is already ${active.status.toLowerCase()} for this source (job ${active.id}).`);
    }
  }

  if (body.type === 'PDF_INGEST' && !body.url) {
    throw badRequest('A url is required to ingest a PDF');
  }

  const jobId = await createJob(body.type as JobType, body.sourceId ?? null, {
    url: body.url,
    documentIds: body.documentIds,
  });

  const { mode } = await enqueueJob(jobId);
  await recordAudit(session.userId, 'start_ingestion', 'IngestionJob', jobId, { type: body.type, mode });

  return NextResponse.json({ jobId, mode, status: 'QUEUED' }, { status: 202 });
});

/** DELETE /api/admin/ingestion?jobId=... — request cancellation. */
export const DELETE = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.EDITOR);
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!jobId) throw badRequest('A jobId is required');

  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Job not found');
  if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.QUEUED) {
    throw badRequest(`Job is already ${job.status.toLowerCase()}`);
  }

  // The runner polls this status between units of work and stops cleanly.
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
  });
  await recordAudit(session.userId, 'cancel_ingestion', 'IngestionJob', jobId);

  return NextResponse.json({ cancelled: true, jobId });
});
