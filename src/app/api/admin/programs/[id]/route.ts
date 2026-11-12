import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  shortDescription: z.string().min(5).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  audience: z.enum(['job_seeker', 'employer', 'both']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'UNKNOWN']).optional(),
  officialUrl: z.string().url().max(2000).nullable().optional(),
  applyUrl: z.string().url().max(2000).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  contactEmail: z.string().email().max(200).nullable().optional(),
  nextSteps: z.string().max(1000).nullable().optional(),
  requiresVerification: z.boolean().optional(),
  keywords: z.array(z.string().max(60)).max(30).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  counties: z.array(z.enum(['Placer', 'El Dorado', 'Alpine'])).optional(),
});

export const PATCH = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.EDITOR);
    const { id } = await context.params;

    const json = await request.json().catch(() => {
      throw badRequest('Request body must be valid JSON');
    });
    const { counties, ...updates } = PatchSchema.parse(json);

    const existing = await prisma.program.findUnique({ where: { id } });
    if (!existing) throw notFound('Program not found');

    const program = await prisma.$transaction(async (tx) => {
      if (counties) {
        await tx.programServiceArea.deleteMany({ where: { programId: id } });
        await tx.programServiceArea.createMany({
          data: counties.map((county) => ({ programId: id, county })),
        });
      }
      return tx.program.update({
        where: { id },
        data: { ...updates, lastVerifiedAt: new Date() },
        include: { serviceAreas: true, rules: true, category: true },
      });
    });

    await recordAudit(session.userId, 'update', 'Program', id, { ...updates, counties });
    return NextResponse.json({ program });
  },
);

export const DELETE = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAdmin(AdminRole.ADMIN);
    const { id } = await context.params;

    const existing = await prisma.program.findUnique({ where: { id }, select: { slug: true } });
    if (!existing) throw notFound('Program not found');

    // Rules and service areas cascade; the link rows to documents do too.
    await prisma.program.delete({ where: { id } });
    await recordAudit(session.userId, 'delete', 'Program', id, { slug: existing.slug });

    return NextResponse.json({ deleted: true });
  },
);
