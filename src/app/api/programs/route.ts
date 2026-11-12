import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { withErrorHandling } from '@/lib/errors';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  audience: z.enum(['job_seeker', 'employer', 'both']).optional(),
  county: z.enum(['Placer', 'El Dorado', 'Alpine']).optional(),
  category: z.string().max(60).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'UNKNOWN']).optional().default('ACTIVE'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

/** GET /api/programs — public catalogue of workforce services. */
export const GET = withErrorHandling(async (request: Request) => {
  const url = new URL(request.url);
  const query = QuerySchema.parse(Object.fromEntries(url.searchParams));

  const programs = await prisma.program.findMany({
    where: {
      status: query.status,
      ...(query.audience ? { audience: { in: [query.audience, 'both'] } } : {}),
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.county ? { serviceAreas: { some: { county: query.county } } } : {}),
    },
    include: {
      category: { select: { slug: true, name: true } },
      serviceAreas: { select: { county: true } },
      // Only rules backed by a published source are exposed publicly.
      rules: {
        where: { verified: true },
        select: { description: true, sourceUrl: true, hard: true },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: query.limit,
  });

  return NextResponse.json({
    count: programs.length,
    programs: programs.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      shortDescription: p.shortDescription,
      audience: p.audience,
      category: p.category,
      counties: p.serviceAreas.map((a) => a.county),
      officialUrl: p.officialUrl,
      applyUrl: p.applyUrl,
      contactPhone: p.contactPhone,
      nextSteps: p.nextSteps,
      requiresVerification: p.requiresVerification,
      eligibility: p.rules,
      lastVerifiedAt: p.lastVerifiedAt?.toISOString() ?? null,
    })),
  });
});
