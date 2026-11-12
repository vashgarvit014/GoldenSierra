import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole, SourceType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { isHostAllowed } from '@/lib/ingest/crawler';

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

  return NextResponse.json({
    sources: sources.map((s) => ({
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
      lastJob: s.jobs[0]
        ? { id: s.jobs[0].id, status: s.jobs[0].status, type: s.jobs[0].type }
        : null,
    })),
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
  // an admin cannot widen it from the dashboard.
  if (body.rootUrl && !isHostAllowed(body.rootUrl)) {
    throw badRequest(
      'That host is not authorized for crawling. Add it to CRAWL_ALLOWED_HOSTS and redeploy first.',
    );
  }

  for (const pattern of [...body.includePatterns, ...body.excludePatterns]) {
    try {
      new RegExp(pattern);
    } catch {
      throw badRequest(`"${pattern}" is not a valid regular expression`);
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

  return NextResponse.json({ source }, { status: 201 });
});
