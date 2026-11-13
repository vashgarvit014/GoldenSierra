'use client';

import { Head, Stat, useApi, useConsole } from '../Console';

/** Shape returned by GET /api/admin/analytics. */
export type AnalyticsPayload = {
  knowledge: {
    totalSources: number;
    totalDocuments: number;
    indexedDocuments: number;
    failedDocuments: number;
    archivedDocuments: number;
    totalChunks: number;
  };
  vector: { healthy: boolean; vectorCount: number; dimensions: number | null; status: string | null };
  index: { indexedDocuments: number; chunksInDb: number; chunksWithVectors: number; missingVectors: number };
  ingestion: {
    failedJobsLast30Days: number;
    recent: {
      id: string;
      type: string;
      status: string;
      sourceName: string | null;
      documentsCreated: number;
      documentsUpdated: number;
      chunksIndexed: number;
      errorCount: number;
      createdAt: string;
      finishedAt: string | null;
    }[];
  };
  usage: {
    totalSessions: number;
    sessionsLast30Days: number;
    totalMessages: number;
    ungroundedAnswersLast30Days: number;
    avgLatencyMs: number;
    avgVectorMs: number;
    avgRerankMs: number;
    topIntents: { intent: string; count: number }[];
  };
  feedback: { helpful: number; notHelpful: number; total: number; helpfulRate: number | null };
  configuration: {
    llmModel: string;
    llmConfigured: boolean;
    embeddingModel: string;
    embeddingDimensions: number;
    queueMode: string;
    retrievalTopK: number;
    retrievalFinalK: number;
    rerankEnabled: boolean;
  };
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function relativeTime(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function Overview() {
  const { go } = useConsole();
  const { data, error, loading, reload } = useApi<AnalyticsPayload>('/api/admin/analytics');

  const k = data?.knowledge;
  const v = data?.vector;
  const idx = data?.index;

  return (
    <>
      <Head
        eyebrow="PLATFORM OVERVIEW"
        title={`${greeting()}, Administrator`}
        sub="Your workforce intelligence workspace, all in one place."
        action={
          <div style={{ display: 'flex', gap: 9 }}>
            <button className="btn" onClick={() => void reload()}>
              ↻ &nbsp; Refresh
            </button>
            <button className="btn primary" onClick={() => go('chat')}>
              ✦ &nbsp; Open AI Assistant
            </button>
          </div>
        }
      />

      {error && <div className="err" style={{ marginBottom: 18 }}>{error}</div>}

      {/* Configuration problems make everything below meaningless, so they lead. */}
      {data && !data.configuration.llmConfigured && (
        <div className="err" style={{ marginBottom: 18 }}>
          <b>No language model configured.</b> Set <code>LLM_API_KEY</code>; until then the
          assistant returns contact details instead of answers.
        </div>
      )}
      {data && !data.vector.healthy && (
        <div className="err" style={{ marginBottom: 18 }}>
          <b>Cannot reach the vector database.</b> Retrieval is unavailable — check{' '}
          <code>QDRANT_URL</code> and that the service is running.
        </div>
      )}
      {idx && idx.missingVectors > 0 && (
        <div className="callout" style={{ marginBottom: 18, marginTop: 0 }}>
          <b>{idx.missingVectors} chunks are not embedded.</b> Some indexed content is not
          searchable — run a re-index from Website Crawler.
        </div>
      )}

      <div className="cards4">
        <Stat
          label="Knowledge Documents"
          icon="▤"
          loading={loading}
          value={k?.totalDocuments ?? 0}
          note={
            <>
              {k?.indexedDocuments ?? 0} indexed
              {k?.failedDocuments ? ` · ${k.failedDocuments} failed` : ''}
            </>
          }
        />
        <Stat
          label="Indexed Chunks"
          icon="▦"
          loading={loading}
          value={k?.totalChunks ?? 0}
          note={
            idx && idx.missingVectors === 0 ? (
              <>
                <span className="good">✓</span> all embedded
              </>
            ) : (
              <>{idx?.chunksWithVectors ?? 0} embedded</>
            )
          }
        />
        <Stat
          label="Vector Records"
          icon="◇"
          loading={loading}
          value={v?.vectorCount ?? 0}
          note={`Qdrant — ${v?.dimensions ?? '—'}d · ${v?.status ?? 'unknown'}`}
        />
        <Stat
          label="Knowledge Sources"
          icon="◎"
          loading={loading}
          value={k?.totalSources ?? 0}
          note="Authorized for crawling"
        />
      </div>

      <div className="layout2">
        <div className="panel">
          <div className="panel-head">
            <h2>Recent Knowledge Activity</h2>
            <span className="fine">Live ingestion jobs</span>
          </div>

          {loading && <div className="empty">Loading…</div>}
          {!loading && data?.ingestion.recent.length === 0 && (
            <div className="empty">
              No ingestion has run yet. Add a source and start a crawl.
            </div>
          )}

          {data?.ingestion.recent.map((job) => {
            const failed = job.status === 'FAILED';
            const done = job.status === 'COMPLETED';
            return (
              <div className="activity" key={job.id}>
                <div className={`activity-icon${failed ? ' gold' : done ? '' : ' blue'}`}>
                  {failed ? '!' : done ? '✓' : '▤'}
                </div>
                <div className="activity-body">
                  <b>{job.sourceName ?? job.type.replace(/_/g, ' ').toLowerCase()}</b>
                  <span>
                    {job.documentsCreated} new · {job.documentsUpdated} updated ·{' '}
                    {job.chunksIndexed} chunks
                    {job.errorCount > 0 && ` · ${job.errorCount} errors`}
                  </span>
                </div>
                <div className="time">{relativeTime(job.createdAt)}</div>
              </div>
            );
          })}

          {data && data.ingestion.failedJobsLast30Days > 0 && (
            <div className="callout">
              {data.ingestion.failedJobsLast30Days} ingestion job
              {data.ingestion.failedJobsLast30Days === 1 ? '' : 's'} failed in the last 30 days.
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>System Status</h2>
            <span className="fine">Live</span>
          </div>

          <div className="system-item">
            <span>PostgreSQL</span>
            <span className={data ? 'green' : 'muted'}>{data ? 'Connected' : '—'}</span>
          </div>
          <div className="system-item">
            <span>Qdrant</span>
            <span className={v?.healthy ? 'green' : 'muted'}>
              {v?.healthy ? 'Healthy' : 'Unreachable'}
            </span>
          </div>
          <div className="system-item">
            <span>Language model</span>
            <span className={data?.configuration.llmConfigured ? 'green' : 'muted'}>
              {data?.configuration.llmModel ?? '—'}
            </span>
          </div>
          <div className="system-item">
            <span>Embeddings</span>
            <span className="muted">
              {data?.configuration.embeddingModel ?? '—'}
              {data ? ` (${data.configuration.embeddingDimensions}d)` : ''}
            </span>
          </div>
          <div className="system-item">
            <span>Job queue</span>
            <span className="muted">{data?.configuration.queueMode ?? '—'}</span>
          </div>
          <div className="system-item">
            <span>Conversations (30d)</span>
            <span className="muted">{data?.usage.sessionsLast30Days ?? 0}</span>
          </div>

          <div className="helper">
            <b>How retrieval works here</b>
            <p>
              Every answer is built from passages retrieved out of this knowledge base, with
              citations. Eligibility is decided by published rules, never by the model — so the
              assistant says “may qualify”, and staff confirm.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
