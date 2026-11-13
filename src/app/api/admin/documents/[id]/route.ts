import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { archiveDocument, deleteDocument, indexDocument } from '@/lib/ingest/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s is the ceiling on Vercel's Hobby plan, and a route declaring more fails
// the deployment outright. Long-running ingestion does not belong in a
// serverless request anyway — run `npm run ingest` from the CLI or a worker.
export const maxDuration = 60;

const PatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  category: z.string().max(60).nullable().optional(),
  audience: z.enum(['job_seeker', 'employer', 'both', 'agency']).nullable().optional(),
  programName: z.string().max(120).nullable().optional(),
  counties: z.array(z.enum(['Placer', 'El Dorado', 'Alpine'])).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  accessLevel: z.enum(['PUBLIC', 'INTERNAL']).optional(),
  /** Re-embed after the change so filters and payloads stay in sync. */
  reindex: z.boolean().default(true),
});

export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireAdmin(AdminRole.VIEWER);
    const { id } = await context.params;

    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        source: { select: { id: true, name: true } },
        chunks: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, ordinal: true, headingPath: true, tokenCount: true, vectorId: true, content: true },
        },
        versions: { orderBy: { version: 'desc' }, take: 5, select: { version: true, createdAt: true, title: true } },
      },
    });
    if (!document) throw notFound('Document not found');

    return NextResponse.json({ document });
  },
);

export const PATCH = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.EDITOR);
    const { id } = await context.params;

    const json = await request.json().catch(() => {
      throw badRequest('Request body must be valid JSON');
    });
    const { reindex, ...updates } = PatchSchema.parse(json);

    const existing = await prisma.document.findUnique({ where: { id } });
    if (!existing) throw notFound('Document not found');

    await prisma.document.update({ where: { id }, data: updates });

    // Classification lives in the Qdrant payload too, so a metadata edit that
    // is not re-indexed would leave retrieval filtering on the old values.
    let chunks = 0;
    if (reindex) ({ chunks } = await indexDocument(id));

    await recordAudit(session.userId, 'update', 'Document', id, { ...updates, reindexed: reindex });
    return NextResponse.json({ updated: true, reindexed: reindex, chunks });
  },
);

/**
 * DELETE /api/admin/documents/:id
 * Default is archive (reversible, removed from the index). ?hard=true erases
 * the record entirely.
 */
export const DELETE = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const hard = new URL(request.url).searchParams.get('hard') === 'true';
    const session = await requireAdmin(hard ? AdminRole.ADMIN : AdminRole.EDITOR);

    const existing = await prisma.document.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!existing) throw notFound('Document not found');

    if (hard) await deleteDocument(id);
    else await archiveDocument(id);

    await recordAudit(session.userId, hard ? 'delete' : 'archive', 'Document', id, {
      title: existing.title,
    });

    return NextResponse.json({ ok: true, mode: hard ? 'deleted' : 'archived' });
  },
);
