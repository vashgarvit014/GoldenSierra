'use client';

import { useEffect, useRef, useState } from 'react';
import { Head, useApi, useConsole } from '../Console';
import { relativeTime } from './Overview';

type Source = {
  id: string;
  name: string;
  type: string;
  rootUrl: string | null;
  status: string;
  documentCount: number;
  maxDepth: number;
  maxPages: number;
  respectRobots: boolean;
  excludePatterns: string[];
  lastCrawledAt: string | null;
};

type Job = {
  id: string;
  type: string;
  status: string;
  sourceName: string | null;
  pagesDiscovered: number;
  pagesProcessed: number;
  documentsCreated: number;
  documentsUpdated: number;
  documentsSkipped: number;
  chunksIndexed: number;
  errorCount: number;
  error: string | null;
  createdAt: string;
};

const PIPELINE = [
  { icon: '◎', label: 'Discover' },
  { icon: '⇩', label: 'Extract' },
  { icon: '▤', label: 'Chunk' },
  { icon: '◇', label: 'Embed' },
  { icon: '✓', label: 'Index' },
];

export function Crawler() {
  const { notify } = useConsole();
  const { data: sourceData, reload: reloadSources } = useApi<{ sources: Source[] }>('/api/admin/sources');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadJobs() {
    const res = await fetch('/api/admin/ingestion/status');
    if (!res.ok) return;
    const body = (await res.json()) as { jobs: Job[] };
    setJobs(body.jobs);
  }

  useEffect(() => {
    void loadJobs();
  }, []);

  // Poll only while something is running — an idle console should be quiet.
  const active = jobs.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
  useEffect(() => {
    if (active && !poll.current) {
      poll.current = setInterval(() => {
        void loadJobs();
        void reloadSources();
      }, 3000);
    } else if (!active && poll.current) {
      clearInterval(poll.current);
      poll.current = null;
    }
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
        poll.current = null;
      }
    };
  }, [active, reloadSources]);

  async function start(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch('/api/admin/ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string; mode?: string };
      if (!res.ok) throw new Error(json.error ?? 'Could not start');
      notify(json.mode === 'queued' ? 'Queued for the worker' : 'Running now — progress below');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
    } finally {
      setBusy(null);
    }
  }

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    setBusy('add');
    setError(null);
    try {
      const res = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || new URL(url).hostname,
          type: 'WEBSITE',
          rootUrl: url,
          maxPages: 150,
          maxDepth: 3,
          respectRobots: true,
          excludePatterns: ['/blog/document/', '/(es|ru|fa|uk)(/|$)', '/calendar(/|$)'],
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Could not add the source');
      notify('Source added');
      setUrl('');
      setName('');
      await reloadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the source');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Head
        eyebrow="INGESTION"
        title="Website Crawler"
        sub="Discover, extract and index approved Golden Sierra content."
        action={
          <button
            className="btn"
            disabled={busy === 'reindex'}
            onClick={() => void start({ type: 'REINDEX' }, 'reindex')}
            title="Re-embed every document — needed after an embedding model change"
          >
            {busy === 'reindex' ? <span className="spin" /> : '↻'} &nbsp; Re-index all
          </button>
        }
      />

      {error && <div className="err" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <h2>Add an authorized source</h2>
          <span className="fine">Host must be allow-listed server-side</span>
        </div>
        <form className="crawler-form" onSubmit={addSource}>
          <input
            id="urlInput"
            type="url"
            required
            placeholder="https://goldensierra.com/"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            placeholder="Label (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 220 }}
          />
          <button className="btn primary" disabled={busy === 'add' || !url}>
            {busy === 'add' ? <span className="spin" /> : '＋'} &nbsp; Add source
          </button>
        </form>
        <p className="info-note" style={{ marginTop: 10 }}>
          The crawler respects robots.txt, rate-limits itself, and never attempts to bypass a
          login. A host that is not in <code>CRAWL_ALLOWED_HOSTS</code> is rejected here.
        </p>

        <div className="pipeline">
          {PIPELINE.map((s) => (
            <div className="pipeline-step" key={s.label}>
              <span aria-hidden="true">{s.icon}</span>
              {s.label}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <h2>Knowledge Sources</h2>
          <span className="fine">{sourceData?.sources.length ?? 0} configured</span>
        </div>

        {!sourceData && <div className="empty">Loading…</div>}
        {sourceData?.sources.length === 0 && (
          <div className="empty">No sources yet — add one above.</div>
        )}

        {!!sourceData?.sources.length && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Documents</th>
                  <th>Depth / Pages</th>
                  <th>Last crawled</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody id="sourceRows">
                {sourceData.sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      {s.rootUrl && (
                        <>
                          <br />
                          <span className="fine">{s.rootUrl}</span>
                        </>
                      )}
                    </td>
                    <td>{s.documentCount}</td>
                    <td className="fine">
                      {s.maxDepth} / {s.maxPages}
                      {s.respectRobots && <> · robots ✓</>}
                    </td>
                    <td className="fine">
                      {s.lastCrawledAt ? relativeTime(s.lastCrawledAt) : 'never'}
                    </td>
                    <td>
                      <span className={`status${s.status === 'ACTIVE' ? '' : ' gray'}`}>
                        {s.status.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn primary"
                        disabled={busy === s.id || active}
                        onClick={() => void start({ type: 'CRAWL', sourceId: s.id }, s.id)}
                      >
                        {busy === s.id ? <span className="spin" /> : '▶'} &nbsp; Crawl
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Ingestion Jobs</h2>
          <span className="fine">{active ? 'Live — refreshing every 3s' : 'Idle'}</span>
        </div>

        {jobs.length === 0 && <div className="empty">No jobs yet.</div>}

        {jobs.map((job) => {
          const pct =
            job.pagesDiscovered > 0
              ? Math.min(100, Math.round((job.pagesProcessed / job.pagesDiscovered) * 100))
              : job.status === 'COMPLETED'
                ? 100
                : 0;
          return (
            <div className="retrieval-card" key={job.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <b style={{ fontSize: 12 }}>
                  {job.sourceName ?? job.type.replace(/_/g, ' ').toLowerCase()}
                </b>
                <span
                  className={`status${
                    job.status === 'COMPLETED'
                      ? ''
                      : job.status === 'FAILED'
                        ? ' warn'
                        : job.status === 'RUNNING'
                          ? ''
                          : ' gray'
                  }`}
                >
                  {job.status.toLowerCase()}
                </span>
              </div>

              {job.status === 'RUNNING' && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
              )}

              <p className="tiny" style={{ marginTop: 8 }}>
                {job.status === 'RUNNING'
                  ? `${job.pagesProcessed} of ${job.pagesDiscovered} pages discovered…`
                  : `${job.documentsCreated} new · ${job.documentsUpdated} updated · ${job.documentsSkipped} unchanged · ${job.chunksIndexed} chunks`}
                {job.errorCount > 0 && ` · ${job.errorCount} errors`}
                {' · '}
                {relativeTime(job.createdAt)}
              </p>
              {job.error && <div className="err" style={{ marginTop: 8 }}>{job.error}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}
