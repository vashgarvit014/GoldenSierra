import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'FAILED']).optional(),
  includePatterns: z.array(z.string().max(300)).max(20).optional(),
  excludePatterns: z.array(z.string().max(300)).max(20).optional(),
  maxDepth: z.number().int().min(0).max(6).optional(),
  maxPages: z.number().int().min(1).max(2000).optional(),
  respectRobots: z.boolean().optional(),
  defaultCategory: z.string().max(60).nullable().optional(),
  recrawlCron: z.string().max(100).nullable().optional(),
});

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
 * Deleting a source detaches its documents rather than cascading, so an
 * operator cannot wipe indexed knowledge by removing a source row. Documents
 * are removed deliberately, through the documents endpoint.
 */
export const DELETE = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.ADMIN);
    const { id } = await context.params;

    const existing = await prisma.knowledgeSource.findUnique({
      where: { id },
      include: { _count: { select: { documents: true } } },
    });
    if (!existing) throw notFound('Source not found');

    await prisma.knowledgeSource.delete({ where: { id } });
    await recordAudit(session.userId, 'delete', 'KnowledgeSource', id, {
      name: existing.name,
      detachedDocuments: existing._count.documents,
    });

    return NextResponse.json({
      deleted: true,
      detachedDocuments: existing._count.documents,
      note: 'Documents from this source were kept and are now unattached. Delete them separately if they should no longer be searchable.',
    });
  },
);
