import { AdminRole } from '@prisma/client';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { Badge, Card, CardContent, CardHeader, CardTitle, Alert } from '@/components/ui';
import { formatDate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Program catalogue. These records are what the recommendation engine reads;
 * the distinction between a verified and an unverified eligibility rule is the
 * most important thing on this page, so it is shown per rule rather than
 * summarised.
 */
export default async function ProgramsPage() {
  await requireAdmin(AdminRole.VIEWER);

  const [programs, categories] = await Promise.all([
    prisma.program.findMany({
      include: { category: true, serviceAreas: true, rules: true, _count: { select: { documents: true } } },
      orderBy: [{ audience: 'asc' }, { sortOrder: 'asc' }],
    }),
    prisma.serviceCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  const unverifiedRules = programs.flatMap((p) => p.rules.filter((r) => !r.verified));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Programs</h1>
        <p className="text-sm text-muted">
          {programs.length} services across {categories.length} categories. Edit through{' '}
          <code className="font-mono text-xs">/api/admin/programs</code> or{' '}
          <code className="font-mono text-xs">prisma/seed.ts</code>.
        </p>
      </div>

      {unverifiedRules.length > 0 && (
        <Alert tone="warning" title={`${unverifiedRules.length} unverified eligibility rules`}>
          An unverified rule never decides eligibility — it cannot exclude anyone and is not shown
          to users. Add the published source URL that states it, then mark it verified.
        </Alert>
      )}

      {(['job_seeker', 'employer', 'both'] as const).map((audience) => {
        const group = programs.filter((p) => p.audience === audience);
        if (group.length === 0) return null;

        return (
          <section key={audience}>
            <h2 className="mb-2 text-sm font-semibold capitalize">
              {audience.replace('_', ' ')} services
            </h2>
            <div className="space-y-3">
              {group.map((program) => (
                <Card key={program.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle>{program.name}</CardTitle>
                        <p className="mt-0.5 font-mono text-xs text-muted">{program.slug}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        <Badge tone={program.status === 'ACTIVE' ? 'success' : 'neutral'}>
                          {program.status.toLowerCase()}
                        </Badge>
                        {program.category && <Badge tone="info">{program.category.name}</Badge>}
                        {program.requiresVerification && (
                          <Badge tone="warning">staff confirm eligibility</Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">{program.shortDescription}</p>

                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                      <Row
                        term="Counties"
                        value={
                          program.serviceAreas.length
                            ? program.serviceAreas.map((a) => a.county).join(', ')
                            : 'Not specified (treated as agency-wide)'
                        }
                      />
                      <Row term="Linked documents" value={String(program._count.documents)} />
                      <Row term="Last verified" value={formatDate(program.lastVerifiedAt)} />
                      <Row term="Keywords" value={program.keywords.join(', ') || '—'} />
                    </dl>

                    {program.officialUrl && (
                      <Link
                        href={program.officialUrl}
                        target="_blank"
                        className="mt-2 inline-block text-xs text-sierra-700 hover:underline dark:text-sierra-300"
                      >
                        {program.officialUrl}
                      </Link>
                    )}

                    {program.rules.length > 0 && (
                      <div className="mt-3 border-t border-default pt-3">
                        <p className="mb-1.5 text-xs font-medium">
                          Eligibility rules ({program.rules.length})
                        </p>
                        <ul className="space-y-1.5">
                          {program.rules.map((rule) => (
                            <li key={rule.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                              <Badge tone={rule.verified ? 'success' : 'warning'}>
                                {rule.verified ? 'verified' : 'unverified'}
                              </Badge>
                              <Badge tone="neutral">{rule.hard ? 'hard' : 'soft'}</Badge>
                              <span className="min-w-0">{rule.description}</span>
                              {rule.sourceUrl && (
                                <a
                                  href={rule.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sierra-600 hover:underline dark:text-sierra-300"
                                >
                                  source
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{term}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
