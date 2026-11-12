import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RuleSchema = z.object({
  field: z.enum([
    'COUNTY', 'EMPLOYMENT_STATUS', 'AGE', 'VETERAN_STATUS',
    'INCOME_LEVEL', 'AUDIENCE', 'DISABILITY_STATUS', 'EDUCATION_LEVEL', 'OTHER',
  ]),
  operator: z.enum(['IN', 'NOT_IN', 'EQUALS', 'GTE', 'LTE', 'BETWEEN', 'EXISTS']),
  value: z.unknown(),
  description: z.string().min(3).max(400),
  hard: z.boolean().default(true),
  sourceUrl: z.string().url().max(2000).nullable().optional(),
  verified: z.boolean().default(false),
});

const ProgramSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens'),
  name: z.string().min(2).max(160),
  shortDescription: z.string().min(5).max(500),
  description: z.string().max(5000).optional(),
  audience: z.enum(['job_seeker', 'employer', 'both']).default('job_seeker'),
  categorySlug: z.string().max(60).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'UNKNOWN']).default('ACTIVE'),
  officialUrl: z.string().url().max(2000).optional(),
  applyUrl: z.string().url().max(2000).optional(),
  contactPhone: z.string().max(40).optional(),
  contactEmail: z.string().email().max(200).optional(),
  nextSteps: z.string().max(1000).optional(),
  requiresVerification: z.boolean().default(true),
  keywords: z.array(z.string().max(60)).max(30).default([]),
  counties: z.array(z.enum(['Placer', 'El Dorado', 'Alpine'])).default([]),
  rules: z.array(RuleSchema).max(20).default([]),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

export const GET = withErrorHandling(async () => {
  await requireAdmin(AdminRole.VIEWER);

  const [programs, categories] = await Promise.all([
    prisma.program.findMany({
      include: {
        category: true,
        serviceAreas: true,
        rules: true,
        _count: { select: { documents: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.serviceCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  return NextResponse.json({ programs, categories });
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.EDITOR);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = ProgramSchema.parse(json);

  // A rule marked verified must point at the page that states it; otherwise
  // the eligibility engine would treat an unsourced claim as authoritative.
  for (const rule of body.rules) {
    if (rule.verified && !rule.sourceUrl) {
      throw badRequest(
        `Rule "${rule.description}" is marked verified but has no source URL. ` +
          'A verified rule must cite the published page that states it.',
      );
    }
  }

  const category = body.categorySlug
    ? await prisma.serviceCategory.findUnique({ where: { slug: body.categorySlug } })
    : null;
  if (body.categorySlug && !category) throw badRequest(`Unknown category "${body.categorySlug}"`);

  const existing = await prisma.program.findUnique({ where: { slug: body.slug } });
  if (existing) throw badRequest(`A program with slug "${body.slug}" already exists`);

  const program = await prisma.program.create({
    data: {
      slug: body.slug,
      name: body.name,
      shortDescription: body.shortDescription,
      description: body.description ?? null,
      audience: body.audience,
      categoryId: category?.id ?? null,
      status: body.status,
      officialUrl: body.officialUrl ?? null,
      applyUrl: body.applyUrl ?? null,
      contactPhone: body.contactPhone ?? null,
      contactEmail: body.contactEmail ?? null,
      nextSteps: body.nextSteps ?? null,
      requiresVerification: body.requiresVerification,
      keywords: body.keywords,
      sortOrder: body.sortOrder,
      lastVerifiedAt: new Date(),
      serviceAreas: { create: body.counties.map((county) => ({ county })) },
      rules: {
        create: body.rules.map((rule) => ({
          field: rule.field,
          operator: rule.operator,
          value: rule.value as never,
          description: rule.description,
          hard: rule.hard,
          sourceUrl: rule.sourceUrl ?? null,
          verified: rule.verified,
        })),
      },
    },
    include: { serviceAreas: true, rules: true },
  });

  await recordAudit(session.userId, 'create', 'Program', program.id, { slug: program.slug });
  return NextResponse.json({ program }, { status: 201 });
});
