import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, withErrorHandling } from '@/lib/errors';
import { DocumentStatus } from '@prisma/client';

export const runtime = 'nodejs';

/** GET /api/programs/:id — accepts either a cuid or a slug. */
export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;

    const program = await prisma.program.findFirst({
      where: { OR: [{ id }, { slug: id }] },
      include: {
        category: true,
        serviceAreas: true,
        rules: { where: { verified: true } },
        documents: {
          include: {
            document: {
              select: { id: true, title: true, url: true, status: true, lastVerifiedAt: true },
            },
          },
        },
      },
    });

    if (!program) throw notFound('That program could not be found.');

    return NextResponse.json({
      id: program.id,
      slug: program.slug,
      name: program.name,
      shortDescription: program.shortDescription,
      description: program.description,
      audience: program.audience,
      status: program.status,
      category: program.category,
      counties: program.serviceAreas.map((a) => ({ county: a.county, notes: a.notes })),
      officialUrl: program.officialUrl,
      applyUrl: program.applyUrl,
      contactPhone: program.contactPhone,
      contactEmail: program.contactEmail,
      nextSteps: program.nextSteps,
      requiresVerification: program.requiresVerification,
      eligibility: program.rules.map((r) => ({
        description: r.description,
        sourceUrl: r.sourceUrl,
        hard: r.hard,
      })),
      // Archived documents are withheld so the public API cannot surface a
      // page that has been withdrawn.
      sources: program.documents
        .filter((pd) => pd.document.status !== DocumentStatus.ARCHIVED)
        .map((pd) => ({
          title: pd.document.title,
          url: pd.document.url,
          lastVerifiedAt: pd.document.lastVerifiedAt?.toISOString() ?? null,
        })),
      lastVerifiedAt: program.lastVerifiedAt?.toISOString() ?? null,
    });
  },
);
