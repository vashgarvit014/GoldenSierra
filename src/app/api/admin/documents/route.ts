import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, DocumentStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { withErrorHandling } from '@/lib/errors';
import { requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['PENDING', 'EXTRACTED', 'INDEXED', 'FAILED', 'ARCHIVED']).optional(),
  category: z.string().max(60).optional(),
  sourceId: z.string().max(40).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET /api/admin/documents — paginated document inventory. */
export const GET = withErrorHandling(async (request: Request) => {
  await requireAdmin(AdminRole.VIEWER);
  const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

  const where = {
    ...(query.status ? { status: query.status as DocumentStatus } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' as const } },
            { url: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, documents] = await Promise.all([
    prisma.document.count({ where }),
    prisma.document.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        title: true,
        url: true,
        type: true,
        status: true,
        category: true,
        audience: true,
        programName: true,
        counties: true,
        tags: true,
        wordCount: true,
        version: true,
        language: true,
        failureReason: true,
        lastVerifiedAt: true,
        crawledAt: true,
        updatedAt: true,
        source: { select: { id: true, name: true } },
        _count: { select: { chunks: true } },
      },
    }),
  ]);

  return NextResponse.json({
    total,
    page: query.page,
    pageSize: query.pageSize,
    documents: documents.map((d) => ({
      ...d,
      chunkCount: d._count.chunks,
      lastVerifiedAt: d.lastVerifiedAt?.toISOString() ?? null,
      crawledAt: d.crawledAt?.toISOString() ?? null,
      updatedAt: d.updatedAt.toISOString(),
    })),
  });
});
