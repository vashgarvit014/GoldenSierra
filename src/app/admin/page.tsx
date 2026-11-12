import { AdminRole, DocumentStatus, FeedbackRating, JobStatus } from '@prisma/client';
import { AlertTriangle, CheckCircle2, Database, FileText, MessageSquare, XCircle } from 'lucide-react';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { collectionStats, qdrantHealthy } from '@/lib/vector/qdrant';
import { auditIndex } from '@/lib/ingest/pipeline';
import { env, hasLlm, hasRedis } from '@/lib/env';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { relativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Dashboard overview. Rendered on the server so the numbers are current on
 * every load, and so no analytics data reaches the browser unless the viewer
 * is authenticated.
 */
export default async function AdminOverview() {
  await requireAdmin(AdminRole.VIEWER);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalDocuments,
    indexedDocuments,
    failedDocuments,
    totalSources,
    recentJobs,
    failedJobs,
    sessions,
    messages,
    helpful,
    notHelpful,
    ungrounded,
    topIntents,
    latency,
    vector,
    vectorUp,
    index,
  ] = await Promise.all([
    prisma.document.count(),
    prisma.document.count({ where: { status: DocumentStatus.INDEXED } }),
    prisma.document.count({ where: { status: DocumentStatus.FAILED } }),
    prisma.knowledgeSource.count(),
    prisma.ingestionJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { source: { select: { name: true } } },
    }),
    prisma.ingestionJob.count({ where: { status: JobStatus.FAILED, createdAt: { gte: since } } }),
    prisma.chatSession.count({ where: { startedAt: { gte: since } } }),
    prisma.chatMessage.count({ where: { createdAt: { gte: since } } }),
    prisma.chatFeedback.count({ where: { rating: FeedbackRating.HELPFUL } }),
    prisma.chatFeedback.count({ where: { rating: FeedbackRating.NOT_HELPFUL } }),
    prisma.retrievalLog.count({ where: { grounded: false, createdAt: { gte: since } } }),
    prisma.retrievalLog.groupBy({
      by: ['intent'],
      _count: { intent: true },
      where: { createdAt: { gte: since } },
      orderBy: { _count: { intent: 'desc' } },
      take: 6,
    }),
    prisma.retrievalLog.aggregate({ _avg: { totalMs: true }, where: { createdAt: { gte: since } } }),
    collectionStats(),
    qdrantHealthy(),
    auditIndex(),
  ]);

  const totalFeedback = helpful + notHelpful;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-muted">Knowledge base health and chatbot usage, last 30 days.</p>
      </div>

      {/* Configuration problems block everything downstream, so they lead. */}
      {!hasLlm() && (
        <Alert tone="warning" title="No language model configured">
          Set <code className="font-mono">LLM_API_KEY</code> in the environment. Until then the
          chatbot returns contact details instead of answers.
        </Alert>
      )}
      {!vectorUp && (
        <Alert tone="danger" title="Cannot reach Qdrant">
          Retrieval is unavailable. Check <code className="font-mono">QDRANT_URL</code> and that the
          service is running.
        </Alert>
      )}
      {index.missingVectors > 0 && (
        <Alert tone="warning" title={`${index.missingVectors} chunks are not embedded`}>
          Some indexed content is not searchable. Run a re-index from Knowledge sources.
        </Alert>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={<FileText className="h-4 w-4" />}
          label="Documents indexed"
          value={indexedDocuments}
          sub={`${totalDocuments} total${failedDocuments ? ` · ${failedDocuments} failed` : ''}`}
        />
        <Stat
          icon={<Database className="h-4 w-4" />}
          label="Vectors in Qdrant"
          value={vector.vectorCount}
          sub={`${index.chunksInDb} chunks · ${vector.dimensions ?? '—'}d`}
        />
        <Stat
          icon={<MessageSquare className="h-4 w-4" />}
          label="Conversations"
          value={sessions}
          sub={`${messages} messages`}
        />
        <Stat
          icon={
            totalFeedback === 0 ? (
              <MessageSquare className="h-4 w-4" />
            ) : helpful >= notHelpful ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )
          }
          label="Rated helpful"
          // No percentage until somebody has actually rated something —
          // "0%" and "no data" mean very different things.
          value={totalFeedback > 0 ? `${Math.round((helpful / totalFeedback) * 100)}%` : '—'}
          sub={totalFeedback > 0 ? `${totalFeedback} ratings` : 'No ratings yet'}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent ingestion</CardTitle>
          </CardHeader>
          <CardContent>
            {recentJobs.length === 0 ? (
              <p className="text-sm text-muted">
                No ingestion has run yet. Add a source and start a crawl.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {recentJobs.map((job) => (
                  <li key={job.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {job.source?.name ?? job.type.replace(/_/g, ' ').toLowerCase()}
                      </p>
                      <p className="text-xs text-muted">
                        {job.documentsCreated} new · {job.documentsUpdated} updated ·{' '}
                        {job.chunksIndexed} chunks
                        {job.errorCount > 0 && ` · ${job.errorCount} errors`}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <JobBadge status={job.status} />
                      <p className="mt-0.5 text-xs text-muted">{relativeTime(job.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {failedJobs > 0 && (
              <p className="mt-3 text-xs text-red-600">
                {failedJobs} job{failedJobs === 1 ? '' : 's'} failed in the last 30 days.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What people ask</CardTitle>
          </CardHeader>
          <CardContent>
            {topIntents.length === 0 ? (
              <p className="text-sm text-muted">No conversations recorded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {topIntents.map((row) => {
                  const max = topIntents[0]?._count.intent ?? 1;
                  return (
                    <li key={row.intent ?? 'unknown'} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {(row.intent ?? 'unknown').replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs text-muted">{row._count.intent}</span>
                      </div>
                      <div className="mt-1 h-1 rounded bg-surface-muted">
                        <div
                          className="h-1 rounded bg-sierra-500"
                          style={{ width: `${Math.max(4, (row._count.intent / max) * 100)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <dl className="mt-4 space-y-1 border-t border-default pt-3 text-xs">
              <Row term="Average response time" value={`${Math.round(latency._avg.totalMs ?? 0)} ms`} />
              <Row
                term="Answers without sources"
                value={String(ungrounded)}
                tone={ungrounded > 0 ? 'warn' : undefined}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row term="Language model" value={env.LLM_MODEL} />
            <Row term="Embedding model" value={`${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS}d)`} />
            <Row term="Vector collection" value={env.QDRANT_COLLECTION} />
            <Row term="Job queue" value={hasRedis() ? 'Redis (BullMQ)' : 'In-process'} />
            <Row term="Knowledge sources" value={String(totalSources)} />
            <Row term="Authorized crawl hosts" value={env.CRAWL_ALLOWED_HOSTS.join(', ')} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 text-muted">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Row({ term, value, tone }: { term: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-muted">{term}</dt>
      <dd className={tone === 'warn' ? 'font-medium text-gold-700' : 'font-medium'}>{value}</dd>
    </div>
  );
}

function JobBadge({ status }: { status: JobStatus }) {
  switch (status) {
    case JobStatus.COMPLETED:
      return (
        <Badge tone="success">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Done
        </Badge>
      );
    case JobStatus.FAILED:
      return (
        <Badge tone="danger">
          <XCircle className="h-3 w-3" aria-hidden="true" />
          Failed
        </Badge>
      );
    case JobStatus.RUNNING:
      return <Badge tone="info">Running</Badge>;
    case JobStatus.QUEUED:
      return <Badge tone="neutral">Queued</Badge>;
    default:
      return <Badge tone="neutral">Cancelled</Badge>;
  }
}
