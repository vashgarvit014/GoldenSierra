import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, JobType, SourceType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError, badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { checkCrawlHost, explainHostRejection } from '@/lib/ingest/crawler';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { CRAWLABLE_TYPES, sourceKey } from '@/lib/ingest/sources';
import { createJob } from '@/lib/ingest/pipeline';
import { enqueueJob, queueHealth } from '@/lib/ingest/queue';
import { readProgress } from '@/lib/ingest/progress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(['WEBSITE', 'SITEMAP', 'SINGLE_PAGE', 'PDF_UPLOAD', 'MANUAL']),
  rootUrl: z.string().url().max(2000).optional(),
  includePatterns: z.array(z.string().max(300)).max(20).default([]),
  excludePatterns: z.array(z.string().max(300)).max(20).default([]),
  maxDepth: z.number().int().min(0).max(6).default(3),
  maxPages: z.number().int().min(1).max(2000).default(200),
  respectRobots: z.boolean().default(true),
  defaultCategory: z.string().max(60).optional(),
  recrawlCron: z.string().max(100).optional(),
  /** Queue the first crawl as soon as the source is saved (default). */
  startCrawl: z.boolean().default(true),
});

/** GET /api/admin/sources — list configured knowledge sources. */
export const GET = withErrorHandling(async () => {
  await requireAdmin(AdminRole.VIEWER);

  const sources = await prisma.knowledgeSource.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { documents: true } },
      jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  // Document and vector state per source, read from the stores that hold them,
  // so "indexed" and "retrievable" are facts rather than a job's say-so.
  const [docStatus, chunkRows] = await Promise.all([
    prisma.document.groupBy({ by: ['sourceId', 'status'], _count: { _all: true } }),
    prisma.$queryRaw<Array<{ sourceId: string | null; chunks: bigint; vectors: bigint }>>`
      SELECT d."sourceId" AS "sourceId", COUNT(*) AS chunks, COUNT(c."vectorId") AS vectors
      FROM "DocumentChunk" c JOIN "Document" d ON d.id = c."documentId"
      GROUP BY d."sourceId"`,
  ]);

  const docsFor = (id: string) => {
    const by: Record<string, number> = {};
    for (const row of docStatus) if (row.sourceId === id) by[row.status] = row._count._all;
    const indexed = by.INDEXED ?? 0;
    const failed = by.FAILED ?? 0;
    const pending = Object.entries(by).reduce(
      (n, [status, count]) => (status === 'INDEXED' || status === 'FAILED' || status === 'ARCHIVED' ? n : n + count),
      0,
    );
    return { indexed, failed, pending, archived: by.ARCHIVED ?? 0 };
  };
  const retrievalFor = (id: string, docs: ReturnType<typeof docsFor>) => {
    const row = chunkRows.find((r) => r.sourceId === id);
    const chunks = Number(row?.chunks ?? 0);
    const vectors = Number(row?.vectors ?? 0);
    const state =
      docs.indexed > 0 && vectors > 0 && vectors === chunks && docs.failed === 0 && docs.pending === 0
        ? 'ready'
        : vectors > 0
          ? 'partial'
          : 'not_ready';
    return { state, chunks, vectors };
  };

  return NextResponse.json({
    allowedHosts: env.CRAWL_ALLOWED_HOSTS,
    sources: sources.map((s) => {
      const docs = docsFor(s.id);
      return {
      id: s.id,
      name: s.name,
      type: s.type,
      rootUrl: s.rootUrl,
      status: s.status,
      documentCount: s._count.documents,
      maxDepth: s.maxDepth,
      maxPages: s.maxPages,
      respectRobots: s.respectRobots,
      includePatterns: s.includePatterns,
      excludePatterns: s.excludePatterns,
      defaultCategory: s.defaultCategory,
      lastCrawledAt: s.lastCrawledAt?.toISOString() ?? null,
      documents: docs,
      retrieval: retrievalFor(s.id, docs),
      lastJob: s.jobs[0]
        ? {
            id: s.jobs[0].id,
            status: s.jobs[0].status,
            type: s.jobs[0].type,
            error: s.jobs[0].error,
            errorCount: s.jobs[0].errorCount,
            progress: readProgress(s.jobs[0].progress),
          }
        : null,
      };
    }),
  });
});

/** POST /api/admin/sources — authorize a new source for indexing. */
export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.EDITOR);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = CreateSchema.parse(json);

  if (body.type !== 'PDF_UPLOAD' && body.type !== 'MANUAL' && !body.rootUrl) {
    throw badRequest('A root URL is required for this source type');
  }

  // The deployment-level allowlist is the final word on what may be crawled;
  // an admin cannot widen it from the dashboard. Say exactly which host was
  // read and what would be accepted, so a rejection is never a guessing game.
  if (body.rootUrl) {
    const verdict = checkCrawlHost(body.rootUrl);
    if (!verdict.ok) {
      logger.warn('Source rejected by crawl allowlist', {
        host: verdict.host,
        reason: verdict.reason,
        allowed: verdict.allowed,
      });
      throw badRequest(explainHostRejection(verdict), {
        reason: verdict.reason,
        host: verdict.host,
        allowedHosts: verdict.allowed,
        suggestion: verdict.suggestion,
      });
    }
  }

  for (const pattern of [...body.includePatterns, ...body.excludePatterns]) {
    try {
      new RegExp(pattern);
    } catch {
      throw badRequest(`"${pattern}" is not a valid regular expression`);
    }
  }

  // One site, one source — spelled differently or not.
  const key = sourceKey(body.rootUrl);
  if (key) {
    const existing = await prisma.knowledgeSource.findMany({
      where: { rootUrl: { not: null } },
      select: { id: true, name: true, rootUrl: true },
    });
    const clash = existing.find((e) => sourceKey(e.rootUrl) === key);
    if (clash) {
      throw new AppError(
        `This site is already a source: "${clash.name}" (${clash.rootUrl}).`,
        409,
        'duplicate_source',
        { sourceId: clash.id },
      );
    }
  }

  const source = await prisma.knowledgeSource.create({
    data: {
      name: body.name,
      type: body.type as SourceType,
      rootUrl: body.rootUrl ?? null,
      includePatterns: body.includePatterns,
      excludePatterns: body.excludePatterns,
      maxDepth: body.maxDepth,
      maxPages: body.maxPages,
      respectRobots: body.respectRobots,
      defaultCategory: body.defaultCategory ?? null,
      recrawlCron: body.recrawlCron ?? null,
      createdById: session.userId,
    },
  });

  await recordAudit(session.userId, 'create', 'KnowledgeSource', source.id, { name: source.name });

  // Queue the first crawl. The source row is already saved, so a failure here
  // is reported alongside it rather than undoing the save.
  let crawl: { jobId: string; mode: 'queued' | 'inline' } | { error: string } | null = null;
  if (body.startCrawl && source.rootUrl && (CRAWLABLE_TYPES as readonly string[]).includes(body.type)) {
    try {
      const jobId = await createJob(JobType.CRAWL, source.id);
      const { mode } = await enqueueJob(jobId);
      await recordAudit(session.userId, 'start_ingestion', 'IngestionJob', jobId, { type: 'CRAWL', mode, trigger: 'source_created' });
      crawl = { jobId, mode };
    } catch (err) {
      crawl = { error: err instanceof Error ? err.message : 'Could not queue the first crawl' };
    }
  }

  return NextResponse.json({ source, crawl, queue: await queueHealth() }, { status: 201 });
});
