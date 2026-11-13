'use client';

import { Head, Stat, useApi } from '../Console';
import type { AnalyticsPayload } from './Overview';

export function Analytics() {
  const { data, loading, error, reload } = useApi<AnalyticsPayload>('/api/admin/analytics');
  const u = data?.usage;
  const f = data?.feedback;
  const max = u?.topIntents[0]?.count ?? 1;

  return (
    <>
      <Head
        eyebrow="INSIGHTS"
        title="Analytics"
        sub="What people ask, how well it is answered, and how fast."
        action={
          <button className="btn" onClick={() => void reload()}>
            ↻ &nbsp; Refresh
          </button>
        }
      />

      {error && <div className="err" style={{ marginBottom: 18 }}>{error}</div>}

      <div className="cards4">
        <Stat label="Conversations (30d)" icon="◉" loading={loading}
          value={u?.sessionsLast30Days ?? 0} note={`${u?.totalSessions ?? 0} all time`} />
        <Stat label="Messages" icon="▤" loading={loading}
          value={u?.totalMessages ?? 0} note="User + assistant turns" />
        <Stat label="Avg response time" icon="◷" loading={loading}
          value={`${u?.avgLatencyMs ?? 0}ms`}
          note={`retrieval ${u?.avgVectorMs ?? 0}ms · rerank ${u?.avgRerankMs ?? 0}ms`} />
        <Stat label="Rated helpful" icon="♡" loading={loading}
          /* null, not 0% — "no ratings" and "rated badly" are different things */
          value={f?.helpfulRate != null ? `${f.helpfulRate}%` : '—'}
          note={f?.total ? `${f.total} ratings` : 'No ratings yet'} />
      </div>

      <div className="layout2">
        <div className="panel">
          <div className="panel-head">
            <h2>What people ask</h2>
            <span className="fine">Last 30 days</span>
          </div>

          {loading && <div className="empty">Loading…</div>}
          {!loading && !u?.topIntents.length && (
            <div className="empty">No conversations recorded yet.</div>
          )}

          {u?.topIntents.map((row) => (
            <div key={row.intent} style={{ marginBottom: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span>{row.intent.replace(/_/g, ' ')}</span>
                <span className="muted">{row.count}</span>
              </div>
              <div className="progress-bar" style={{ margin: 0 }}>
                <div className="progress-fill"
                  style={{ width: `${Math.max(4, (row.count / max) * 100)}%`, background: 'var(--blue)' }} />
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Answer quality</h2>
          </div>

          <div className="system-item">
            <span>Helpful ratings</span><span className="green">{f?.helpful ?? 0}</span>
          </div>
          <div className="system-item">
            <span>Not helpful</span><span className="muted">{f?.notHelpful ?? 0}</span>
          </div>
          <div className="system-item">
            <span>Answers without sources (30d)</span>
            <span className={u && u.ungroundedAnswersLast30Days > 0 ? 'muted' : 'green'}>
              {u?.ungroundedAnswersLast30Days ?? 0}
            </span>
          </div>
          <div className="system-item">
            <span>Documents indexed</span>
            <span className="muted">{data?.knowledge.indexedDocuments ?? 0}</span>
          </div>
          <div className="system-item">
            <span>Chunks searchable</span>
            <span className="muted">{data?.index.chunksWithVectors ?? 0}</span>
          </div>

          <div className="helper">
            <b>Reading these numbers</b>
            <p>
              “Answers without sources” is the one to watch: a rising count means retrieval is
              missing content people are actually asking about. Check the RAG Testing Lab with the
              same question to see what came back.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
