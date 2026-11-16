import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, JobType, SourceType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError, badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { allowHttp } from '@/lib/net/policy';
import { checkRateLimit } from '@/lib/rate-limit';
import { SourceUrlError, validateSourceUrl } from '@/lib/ingest/source-url';
import { scopeHostOf } from '@/lib/ingest/crawler';
import { CRAWLABLE_TYPES, sourceKey } from '@/lib/ingest/sources';
import { createJob } from '@/lib/ingest/pipeline';
import { enqueueJob, queueHealth } from '@/lib/ingest/queue';
import { readProgress } from '@/lib/ingest/progress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(['WEBSITE', 'SITEMAP', 'SINGLE_PAGE', 'PDF_UPLOAD', 'MANUAL']),
  // Syntax is checked by validateSourceUrl, which explains *why* a URL is refused.
  rootUrl: z.string().max(2000).optional(),
  includePatterns: z.array(z.string().max(300)).max(20).default([]),
  excludePatterns: z.array(z.string().max(300)).max(20).default([]),
  maxDepth: z.number().int().min(0).max(6).default(3),
  maxPages: z.number().int().min(1).max(2000).default(200),
  /** robots.txt compliance cannot be switched off from the dashboard. */
  respectRobots: z.literal(true).default(true),
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
    policy: {
      // No fixed domain list: any public website may be registered.
      mode: env.CRAWL_RESTRICT_HOSTS.length ? 'restricted' : 'open',
      restrictedTo: env.CRAWL_RESTRICT_HOSTS,
      httpsRequired: !allowHttp(),
      maxPagesCap: env.CRAWL_MAX_PAGES,
    },
    sources: sources.map((s) => {
      const docs = docsFor(s.id);
      return {
      id: s.id,
      name: s.name,
      type: s.type,
      rootUrl: s.rootUrl,
      scopeHost: s.rootUrl ? scopeHostOf(s.rootUrl) : null,
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

  const crawlable = (CRAWLABLE_TYPES as readonly string[]).includes(body.type);
  if (crawlable && !body.rootUrl) throw badRequest('A website URL is required for this source type');

  // Registration is rate limited per administrator and capped overall, so a
  // compromised or careless account cannot register unbounded sources.
  const limited = await checkRateLimit(`source-add:${session.userId}`, env.SOURCE_ADD_RATE_PER_HOUR, 3_600_000);
  if (!limited.allowed) {
    throw new AppError(
      `Too many sources added recently (limit ${env.SOURCE_ADD_RATE_PER_HOUR} per hour). Try again later.`,
      429,
      'rate_limited',
    );
  }
  if ((await prisma.knowledgeSource.count()) >= env.MAX_SOURCES) {
    throw badRequest(`This deployment is limited to ${env.MAX_SOURCES} sources. Remove one first.`);
  }

  // Validate the site: syntax, https, no credentials, not local/private, the
  // denylist, and a DNS answer that is public — all server-side.
  let rootUrl: string | null = null;
  if (body.rootUrl) {
    try {
      rootUrl = (await validateSourceUrl(body.rootUrl)).url;
    } catch (err) {
      if (err instanceof SourceUrlError) {
        logger.warn('Source rejected', { host: err.host, reason: err.reason });
        await recordAudit(session.userId, 'source_rejected', 'KnowledgeSource', null, {
          reason: err.reason,
          host: err.host,
        });
        throw badRequest(err.message, { reason: err.reason, host: err.host });
      }
      throw err;
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
  const key = sourceKey(rootUrl);
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
      rootUrl,
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

  await recordAudit(session.userId, 'create', 'KnowledgeSource', source.id, { name: source.name, host: rootUrl ? scopeHostOf(rootUrl) : null });

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
