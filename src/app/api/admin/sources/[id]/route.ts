import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, DocumentStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { archiveSourceDocuments } from '@/lib/ingest/pipeline';
import { scopeHostOf } from '@/lib/ingest/crawler';
import { readProgress } from '@/lib/ingest/progress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'FAILED']).optional(),
  includePatterns: z.array(z.string().max(300)).max(20).optional(),
  excludePatterns: z.array(z.string().max(300)).max(20).optional(),
  maxDepth: z.number().int().min(0).max(6).optional(),
  maxPages: z.number().int().min(1).max(2000).optional(),
  /** robots.txt compliance cannot be turned off. */
  respectRobots: z.literal(true).optional(),
  defaultCategory: z.string().max(60).nullable().optional(),
  recrawlCron: z.string().max(100).nullable().optional(),
});

/** GET /api/admin/sources/[id] — source details: documents, chunk counts, recent crawls and their errors. */
export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireAdmin(AdminRole.VIEWER);
    const { id } = await context.params;
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 25) || 25));
    const statusFilter = url.searchParams.get('status');

    const source = await prisma.knowledgeSource.findUnique({ where: { id } });
    if (!source) throw notFound('Source not found');

    const where = {
      sourceId: id,
      ...(statusFilter && statusFilter in DocumentStatus ? { status: statusFilter as DocumentStatus } : {}),
    };
    const [documents, total, byStatus, chunkAgg, jobs] = await Promise.all([
      prisma.document.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, title: true, url: true, status: true, audience: true, category: true,
          wordCount: true, lastVerifiedAt: true, failureReason: true, _count: { select: { chunks: true } },
        },
      }),
      prisma.document.count({ where }),
      prisma.document.groupBy({ by: ['status'], where: { sourceId: id }, _count: { _all: true } }),
      prisma.documentChunk.aggregate({ where: { document: { sourceId: id } }, _count: { _all: true } }),
      prisma.ingestionJob.findMany({ where: { sourceId: id }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);

    return NextResponse.json({
      source: {
        id: source.id, name: source.name, type: source.type, rootUrl: source.rootUrl,
        scopeHost: source.rootUrl ? scopeHostOf(source.rootUrl) : null,
        status: source.status, maxDepth: source.maxDepth, maxPages: source.maxPages,
        respectRobots: source.respectRobots, lastCrawledAt: source.lastCrawledAt?.toISOString() ?? null,
        createdAt: source.createdAt.toISOString(),
      },
      documentCounts: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      chunkCount: chunkAgg._count._all,
      documents: documents.map((d) => ({
        id: d.id, title: d.title, url: d.url, status: d.status, audience: d.audience, category: d.category,
        words: d.wordCount, chunks: d._count.chunks, lastVerifiedAt: d.lastVerifiedAt?.toISOString() ?? null,
        failureReason: d.failureReason,
      })),
      page: { page, pageSize, total },
      jobs: jobs.map((j) => ({
        id: j.id, type: j.type, status: j.status, createdAt: j.createdAt.toISOString(),
        finishedAt: j.finishedAt?.toISOString() ?? null, pagesProcessed: j.pagesProcessed,
        documentsCreated: j.documentsCreated, documentsUpdated: j.documentsUpdated,
        documentsSkipped: j.documentsSkipped, chunksIndexed: j.chunksIndexed, errorCount: j.errorCount,
        error: j.error, progress: readProgress(j.progress),
        problems: Array.isArray(j.log)
          ? (j.log as { level: string; message: string; url?: string }[]).filter((l) => l.level !== 'info').slice(0, 25)
          : [],
      })),
    });
  },
);

export const PATCH = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.EDITOR);
    const { id } = await context.params;

    const json = await request.json().catch(() => {
      throw badRequest('Request body must be valid JSON');
    });
    const body = UpdateSchema.parse(json);

    const existing = await prisma.knowledgeSource.findUnique({ where: { id } });
    if (!existing) throw notFound('Source not found');

    const source = await prisma.knowledgeSource.update({ where: { id }, data: body });
    await recordAudit(session.userId, 'update', 'KnowledgeSource', id, body);

    return NextResponse.json({ source });
  },
);

/**
 * DELETE /api/admin/sources/[id]?documents=archive|keep  (default: keep)
 *
 * Retention policy, chosen explicitly by the administrator:
  *   archive           — the source's content is taken out of search: vectors
 *                       and chunks are removed, document rows are kept as ARCHIVED
 *   keep              — only the source record goes; its documents stay searchable
 *                       (and unattached) so indexed knowledge is never lost by accident
 */
export const DELETE = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.ADMIN);
    const { id } = await context.params;
    const mode = new URL(request.url).searchParams.get('documents') ?? 'keep';
    if (mode !== 'archive' && mode !== 'keep') throw badRequest('documents must be "archive" or "keep"');

    const existing = await prisma.knowledgeSource.findUnique({
      where: { id },
      include: { _count: { select: { documents: true } } },
    });
    if (!existing) throw notFound('Source not found');

    // Refuse while a crawl is running: it would keep writing documents for a source that no longer exists.
    const active = await prisma.ingestionJob.findFirst({ where: { sourceId: id, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active) throw badRequest(`A crawl is ${active.status.toLowerCase()} for this source. Cancel it first.`);

    const archived = mode === 'archive' ? await archiveSourceDocuments(id) : 0;
    await prisma.knowledgeSource.delete({ where: { id } });
    await recordAudit(session.userId, 'delete', 'KnowledgeSource', id, {
      name: existing.name,
      documents: mode,
      archivedDocuments: archived,
      detachedDocuments: mode === 'keep' ? existing._count.documents : 0,
    });

    return NextResponse.json({
      deleted: true,
      mode,
      archivedDocuments: archived,
      detachedDocuments: mode === 'keep' ? existing._count.documents : 0,
      note:
        mode === 'archive'
          ? 'The source and its content were removed from search. Document records are kept as archived.'
          : 'Documents from this source were kept and are now unattached. Delete them separately if they should no longer be searchable.',
    });
  },
);
