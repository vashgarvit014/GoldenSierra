'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Head, useApi, useConsole } from '../Console';
import { statusClass } from '@/lib/status';
import { STAGES, type JobProgress, type StageId } from '@/lib/ingest/progress';
import { relativeTime } from './Overview';

type Source = {
  id: string;
  name: string;
  type: string;
  rootUrl: string | null;
  scopeHost: string | null;
  status: string; // source enabled/paused — not a crawl status
  documentCount: number;
  maxDepth: number;
  maxPages: number;
  respectRobots: boolean;
  excludePatterns: string[];
  lastCrawledAt: string | null;
  documents: { indexed: number; failed: number; pending: number; archived: number };
  retrieval: { state: 'ready' | 'partial' | 'not_ready'; chunks: number; vectors: number };
  lastJob: {
    id: string;
    status: string;
    type: string;
    error: string | null;
    errorCount: number;
    progress: JobProgress | null;
  } | null;
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
  log: { level: string; message: string; url?: string }[] | null;
  progress: JobProgress | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type SourceDetail = {
  documentCounts: Record<string, number>;
  chunkCount: number;
  documents: { id: string; title: string; url: string | null; status: string; chunks: number; words: number; failureReason: string | null }[];
  page: { page: number; pageSize: number; total: number };
  jobs: {
    id: string; status: string; createdAt: string; pagesProcessed: number; documentsCreated: number; documentsUpdated: number;
    documentsSkipped: number; chunksIndexed: number; errorCount: number; error: string | null;
    problems: { level: string; message: string; url?: string }[];
  }[];
};

type RetrievalTest = {
  answer: string;
  citations: { title: string; url: string | null }[];
  retrievedSources: { title: string; url: string | null; headingPath: string | null; score: number; snippet: string }[];
};

type QueueHealth = { enabled: boolean; waiting: number; active: number; workers: number };

const STAGE_META: Record<StageId, { icon: string; label: string }> = {
  discover: { icon: '◎', label: 'Discover' },
  extract: { icon: '⇩', label: 'Extract' },
  chunk: { icon: '▤', label: 'Chunk' },
  embed: { icon: '◇', label: 'Embed' },
  index: { icon: '✓', label: 'Index' },
};

const RETRIEVAL_LABEL = { ready: 'ready', partial: 'partial', not_ready: 'not ready' } as const;

/** Server validation errors arrive as { error, issues: [{ path, message }] }. */
function apiMessage(json: { error?: string; issues?: { path?: string; message?: string }[] }, fallback: string) {
  const issues = (json.issues ?? [])
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .filter(Boolean);
  return issues.length ? issues.join(' · ') : (json.error ?? fallback);
}

export function Crawler() {
  const { notify, role } = useConsole();
  const canEdit = role === 'EDITOR' || role === 'ADMIN';
  const canDelete = role === 'ADMIN';

  const { data: sourceData, reload: reloadSources } = useApi<{ sources: Source[]; policy?: { mode: 'open' | 'restricted'; restrictedTo: string[]; httpsRequired: boolean; maxPagesCap?: number } }>('/api/admin/sources');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queue, setQueue] = useState<QueueHealth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [maxPages, setMaxPages] = useState(150);
  const [maxDepth, setMaxDepth] = useState(3);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [docStatus, setDocStatus] = useState('');
  const [testQuestion, setTestQuestion] = useState('');
  const [retrieval, setRetrieval] = useState<RetrievalTest | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmUnindex, setConfirmUnindex] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(async () => {
    const res = await fetch('/api/admin/ingestion/status');
    if (!res.ok) return;
    const body = (await res.json()) as { jobs: Job[]; queue?: QueueHealth | null };
    setJobs(body.jobs);
    setQueue(body.queue ?? null);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Poll only while something is queued or running — an idle console is quiet.
  const active = jobs.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
  useEffect(() => {
    if (active && !poll.current) {
      poll.current = setInterval(() => {
        void loadJobs();
        void reloadSources();
      }, 2000);
    } else if (!active && poll.current) {
      clearInterval(poll.current);
      poll.current = null;
      void reloadSources(); // one last read so the table shows the final state
    }
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
        poll.current = null;
      }
    };
  }, [active, loadJobs, reloadSources]);

  // Keep an open detail panel current while a crawl is running.
  useEffect(() => {
    if (expanded && active) void loadDetail(expanded, 1, docStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

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
      if (!res.ok) throw new Error(apiMessage(json, 'Could not start'));
      notify(json.mode === 'queued' ? 'Queued for the worker' : 'Running now — progress below');
      await Promise.all([loadJobs(), reloadSources()]);
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
      let label = name.trim();
      if (!label) {
        try {
          label = new URL(url).hostname || url.trim().slice(0, 60);
        } catch {
          throw new Error('Enter a full URL, starting with https://');
        }
      }
      const res = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: label,
          type: 'WEBSITE',
          rootUrl: url.trim(),
          maxPages,
          maxDepth,
          respectRobots: true,
          excludePatterns: ['/blog/document/', '/(es|ru|fa|uk)(/|$)', '/calendar(/|$)'],
          startCrawl: true,
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        issues?: { path?: string; message?: string }[];
        crawl?: { jobId?: string; mode?: string; error?: string } | null;
        updated?: boolean;
        source?: { name?: string; maxPages?: number; maxDepth?: number };
      };
      if (!res.ok) throw new Error(apiMessage(json, 'Could not add the source'));

      if (json.updated) {
        notify(`${json.source?.name ?? 'That site'} is already a source — limits updated (depth ${json.source?.maxDepth}, up to ${json.source?.maxPages} pages) and a re-crawl ${json.crawl && !json.crawl.error ? 'started' : 'could not be queued'}`);
      } else if (json.crawl?.error) {
        setError(`Source saved, but the first crawl could not be queued: ${json.crawl.error}`);
      } else {
        notify(json.crawl?.mode === 'queued' ? 'Source added — first crawl queued for the worker' : 'Source added — first crawl running');
      }
      setUrl('');
      setName('');
      setMaxPages(150);
      setMaxDepth(3);
      await Promise.all([loadJobs(), reloadSources()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the source');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(source: Source) {
    const next = source.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    setBusy(`toggle:${source.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(apiMessage(await res.json(), 'Could not update the source'));
      notify(next === 'PAUSED' ? 'Source paused' : 'Source resumed');
      await reloadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the source');
    } finally {
      setBusy(null);
    }
  }

  async function remove(source: Source, documents: 'archive' | 'keep') {
    setBusy(`delete:${source.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}?documents=${documents}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(apiMessage(await res.json(), 'Could not remove the source'));
      notify(documents === 'archive' ? 'Source removed and taken out of search' : 'Source removed — its documents were kept');
      setConfirmRemove(null);
      if (expanded === source.id) setExpanded(null);
      await reloadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the source');
    } finally {
      setBusy(null);
    }
  }

  /** Take a paused source's content out of the knowledge base, or put it back (re-indexed from stored text). */
  async function knowledge(source: Source, action: 'remove_from_kb' | 'restore_to_kb') {
    setBusy(`kb:${source.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(apiMessage(json, 'Could not update the knowledge base'));
      notify(json.message ?? (action === 'remove_from_kb' ? 'Removed from the knowledge base' : 'Restoring to the knowledge base'));
      setConfirmUnindex(null);
      await Promise.all([loadJobs(), reloadSources()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the knowledge base');
    } finally {
      setBusy(null);
    }
  }

  async function cancelJob(jobId: string) {
    setBusy(`cancel:${jobId}`);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ingestion?jobId=${jobId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(apiMessage(await res.json(), 'Could not cancel'));
      notify('Cancelling — the crawler stops at the next page');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusy(null);
    }
  }

  const loadDetail = useCallback(async (id: string, page = 1, status = '') => {
    const res = await fetch(`/api/admin/sources/${id}?page=${page}&pageSize=10${status ? `&status=${status}` : ''}`);
    if (res.ok) setDetail((await res.json()) as SourceDetail);
  }, []);

  async function toggleDetail(source: Source) {
    if (expanded === source.id) {
      setExpanded(null);
      return;
    }
    setExpanded(source.id);
    setDetail(null);
    setRetrieval(null);
    setDocStatus('');
    await loadDetail(source.id);
  }

  async function testRetrieval(source: Source) {
    if (!testQuestion.trim()) return;
    setBusy(`test:${source.id}`);
    setRetrieval(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/test-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: testQuestion, sourceId: source.id }),
      });
      const json = (await res.json()) as RetrievalTest & { error?: string };
      if (!res.ok) throw new Error(apiMessage(json, 'Retrieval test failed'));
      setRetrieval(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retrieval test failed');
    } finally {
      setBusy(null);
    }
  }

  // The pipeline panel follows the job that is live now, else the newest one.
  const liveJob = jobs.find((j) => j.status === 'RUNNING') ?? jobs.find((j) => j.status === 'QUEUED') ?? jobs.find((j) => j.progress) ?? null;

  return (
    <>
      <Head
        eyebrow="INGESTION"
        title="Website Crawler"
        sub="Discover, extract and index approved Golden Sierra content."
        action={
          canEdit ? (
            <button
              className="btn"
              disabled={busy === 'reindex' || active}
              onClick={() => void start({ type: 'REINDEX' }, 'reindex')}
              title="Re-embed every document — needed after an embedding model change"
            >
              {busy === 'reindex' ? <span className="spin" /> : '↻'} &nbsp; Re-index all
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="err" role="alert" id="crawlerError" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {canEdit && (
        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-head">
            <h2>Add an authorized source</h2>
            <span className="fine">Host must be allow-listed server-side</span>
          </div>
          <form className="crawler-form" onSubmit={addSource}>
            <input
              id="urlInput"
              aria-label="Website URL"
              type="url"
              required
              placeholder="https://goldensierra.com/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              id="labelInput"
              aria-label="Source label"
              placeholder="Label (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button className="btn primary" id="addSourceBtn" disabled={busy === 'add' || !url}>
              {busy === 'add' ? <span className="spin" /> : '＋'} &nbsp; Add source &amp; crawl
            </button>
          </form>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="fine">
              Link depth{' '}
              <input id="maxDepthInput" className="limit-input" type="number" min={0} max={6} value={maxDepth} onChange={(e) => setMaxDepth(Math.max(0, Number(e.target.value) || 0))} style={{ width: 80 }} />
            </label>
            <label className="fine">
              Max pages{' '}
              <input id="maxPagesInput" className="limit-input" type="number" min={1} max={sourceData?.policy?.maxPagesCap ?? 2000} title="To change an existing source's limits, enter its URL again with the new limits."  value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 1)} style={{ width: 100 }} />
            </label>
          </div>
          <p className="info-note" id="policyNote" style={{ marginTop: 10 }}>
            Add any public website you are permitted to crawl. {sourceData?.policy?.httpsRequired !== false && 'It must use https://. '}
            Private, local, internal and cloud-metadata addresses are always refused, and each source is
            limited to its own domain. The crawler obeys robots.txt (including crawl delays), is rate-limited,
            and never logs in or follows links to other sites. Saving a source queues its first crawl automatically.
            {sourceData?.policy?.mode === 'restricted' && <> This deployment only allows: <b>{sourceData.policy.restrictedTo.join(', ')}</b>.</>}
          </p>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 20 }} id="pipelinePanel">
        <div className="panel-head">
          <h2>Pipeline{liveJob ? ` — ${liveJob.sourceName ?? liveJob.type.replace(/_/g, ' ').toLowerCase()}` : ''}</h2>
          {liveJob ? <span className={statusClass(liveJob.status)}>{liveJob.status.toLowerCase()}</span> : <span className="fine">No crawl yet</span>}
        </div>
        <div className="queue-line" id="queueLine">
          {queue === null ? (
            <span>Queue status unavailable</span>
          ) : !queue.enabled ? (
            <span>No Redis — jobs run inside the web server process</span>
          ) : (
            <>
              <span className={queue.workers > 0 ? 'status done' : 'status failed'}>
                {queue.workers > 0 ? `worker online (${queue.workers})` : 'no worker running'}
              </span>
              <span>{queue.waiting} waiting</span>
              <span>{queue.active} active</span>
            </>
          )}
        </div>
        <StageRail job={liveJob} />
        {liveJob && (
          <p className="tiny" id="liveCounts" style={{ marginTop: 10 }} data-testid="live-counts">
            <b>{liveJob.pagesDiscovered}</b> pages discovered · <b>{liveJob.progress?.stages.extract.done ?? 0}</b> extracted ·{' '}
            <b>{liveJob.progress?.stages.chunk.count ?? 0}</b> chunks created · <b>{liveJob.progress?.stages.embed.count ?? 0}</b> embeddings generated ·{' '}
            <b>{liveJob.progress?.stages.index.count ?? 0}</b> vectors indexed · <b>{liveJob.progress?.stages.extract.errors ?? 0}</b> failed pages
          </p>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <h2>Knowledge Sources</h2>
          <span className="fine">{sourceData?.sources.length ?? 0} configured</span>
        </div>

        {!sourceData && <div className="empty">Loading…</div>}
        {sourceData?.sources.length === 0 && (
          <div className="empty">No sources yet{canEdit ? ' — add one above.' : '.'}</div>
        )}

        {!!sourceData?.sources.length && (
          <div className="table-wrap">
            <table className="table" id="sourcesTable">
              <thead>
                <tr>
                  <th>Source</th>
                  <th title="Whether the source may be crawled">Source</th>
                  <th title="Status of the most recent crawl job">Last crawl</th>
                  <th title="Documents stored for this source and their indexing state">Documents</th>
                  <th title="Whether this source's content is searchable right now">Retrieval</th>
                  <th />
                </tr>
              </thead>
              <tbody id="sourceRows">
                {sourceData.sources.map((s) => {
                  const runningJob = jobs.find((j) => j.sourceName === s.name && (j.status === 'RUNNING' || j.status === 'QUEUED'));
                  const isOpen = expanded === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr data-source-id={s.id}>
                        <td>
                          <b>{s.name}</b>
                          {s.rootUrl && (
                            <>
                              <br />
                              <span className="fine">{s.rootUrl}</span>
                            </>
                          )}
                          <div className="fine">
                            scope {s.scopeHost ?? '—'} · depth {s.maxDepth} · up to {Math.min(s.maxPages, sourceData?.policy?.maxPagesCap ?? s.maxPages)} pages{(sourceData?.policy?.maxPagesCap ?? Infinity) < s.maxPages && ` (server limit ${sourceData?.policy?.maxPagesCap})`}{s.respectRobots && ' · robots ✓'}
                          </div>
                          <div className="fine" data-testid="last-success">
                            {s.lastCrawledAt ? `last successful crawl ${relativeTime(s.lastCrawledAt)}` : 'no successful crawl yet'}
                          </div>
                          {s.lastJob && (s.lastJob.status === 'FAILED' || s.lastJob.status === 'PARTIAL') && s.lastJob.error && (
                            <div className={s.lastJob.status === 'FAILED' ? 'err' : 'info-note'} style={{ marginTop: 6 }} data-testid="source-error">
                              {s.lastJob.error}
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={statusClass(s.status)} data-testid="source-status">
                            {s.status === 'ACTIVE' ? 'enabled' : s.status.toLowerCase()}
                          </span>
                        </td>
                        <td>
                          {s.lastJob ? (
                            <span className={statusClass(s.lastJob.status)} data-testid="crawl-status">
                              {s.lastJob.status.toLowerCase()}
                            </span>
                          ) : (
                            <span className="fine">none</span>
                          )}
                        </td>
                        <td className="fine" data-testid="doc-state">
                          <b>{s.documents.indexed}</b> indexed
                          {s.documents.pending > 0 && <> · {s.documents.pending} pending</>}
                          {s.documents.failed > 0 && <> · {s.documents.failed} failed</>}
                          {s.documents.archived > 0 && s.documents.indexed === 0 && <><br />{s.documents.archived} removed from knowledge base</>}
                        </td>
                        <td>
                          <span className={statusClass(s.retrieval.state === 'not_ready' ? 'queued' : s.retrieval.state)} data-testid="retrieval-state">
                            {RETRIEVAL_LABEL[s.retrieval.state]}
                          </span>
                          <div className="fine">{s.retrieval.vectors} / {s.retrieval.chunks} chunks</div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <button className="btn" data-action="details" aria-expanded={isOpen} onClick={() => void toggleDetail(s)}>
                              {isOpen ? 'Hide' : 'Details'}
                            </button>
                            {canEdit && (
                              <>
                                {runningJob ? (
                                  <button className="btn" data-action="cancel" disabled={busy === `cancel:${runningJob.id}`} onClick={() => void cancelJob(runningJob.id)}>
                                    Cancel
                                  </button>
                                ) : (
                                  <button
                                    className="btn primary"
                                    data-action="crawl"
                                    disabled={busy === s.id || active || s.status === 'PAUSED'}
                                    title={s.status === 'PAUSED' ? 'Resume the source to crawl it' : 'Re-crawl: only changed pages are re-embedded'}
                                    onClick={() => void start({ type: 'CRAWL', sourceId: s.id }, s.id)}
                                  >
                                    {busy === s.id ? <span className="spin" /> : '▶'} &nbsp; {s.lastCrawledAt ? 'Re-crawl' : 'Crawl'}
                                  </button>
                                )}
                                <button className="btn" data-action="toggle" disabled={busy === `toggle:${s.id}`} onClick={() => void toggle(s)} title="Pausing stops crawling. Its content stays searchable until you remove it from the knowledge base.">
                                  {s.status === 'PAUSED' ? 'Resume' : 'Pause'}
                                </button>
                                {s.status === 'PAUSED' && s.documents.indexed > 0 && (
                                  <button className="btn" data-action="remove-from-kb" disabled={busy === `kb:${s.id}` || Boolean(runningJob)} onClick={() => setConfirmUnindex(confirmUnindex === s.id ? null : s.id)} title="Stop the chatbot from using this source's content; the source and its pages are kept">
                                    Remove from knowledge base
                                  </button>
                                )}
                                {s.documents.archived > 0 && s.documents.indexed === 0 && (
                                  <button className="btn" data-action="restore-to-kb" disabled={busy === `kb:${s.id}` || Boolean(runningJob)} onClick={() => void knowledge(s, 'restore_to_kb')} title="Re-index this source's saved pages so the chatbot uses them again (no re-crawl)">
                                    {busy === `kb:${s.id}` ? <span className="spin" /> : null} Restore to knowledge base
                                  </button>
                                )}
                                {canDelete && (
                                  <button className="btn" data-action="remove" onClick={() => setConfirmRemove(confirmRemove === s.id ? null : s.id)}>
                                    Remove
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                          {confirmUnindex === s.id && (
                            <div className="info-note" style={{ marginTop: 8 }} data-testid="unindex-confirm">
                              <b>Take “{s.name}” out of the knowledge base?</b> The chatbot will stop using its {s.documents.indexed} page{s.documents.indexed === 1 ? '' : 's'}. The source and the saved pages are kept, so you can restore it later without re-crawling.
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                <button className="btn primary" data-action="confirm-remove-from-kb" disabled={busy === `kb:${s.id}`} onClick={() => void knowledge(s, 'remove_from_kb')}>
                                  {busy === `kb:${s.id}` ? <span className="spin" /> : null} Remove from knowledge base
                                </button>
                                <button className="btn" onClick={() => setConfirmUnindex(null)}>Cancel</button>
                              </div>
                            </div>
                          )}
                          {confirmRemove === s.id && (
                            <div className="info-note" style={{ marginTop: 8 }} data-testid="remove-confirm">
                              <b>Remove “{s.name}”?</b>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                <button className="btn primary" data-action="remove-archive" disabled={busy === `delete:${s.id}`} onClick={() => void remove(s, 'archive')}>
                                  Remove &amp; take out of search
                                </button>
                                <button className="btn" data-action="remove-keep" disabled={busy === `delete:${s.id}`} onClick={() => void remove(s, 'keep')}>
                                  Remove, keep documents
                                </button>
                                <button className="btn" onClick={() => setConfirmRemove(null)}>Cancel</button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr data-detail-for={s.id}>
                          <td colSpan={6} style={{ background: 'var(--muted)' }}>
                            {!detail ? (
                              <div className="empty">Loading…</div>
                            ) : (
                              <div data-testid="source-detail">
                                <p className="tiny">
                                  <b>{detail.chunkCount}</b> chunks across{' '}
                                  {Object.entries(detail.documentCounts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') || 'no documents'}
                                </p>

                                <h3 style={{ margin: '12px 0 6px', fontSize: 14 }}>Test retrieval from this source</h3>
                                <form
                                  className="question-box"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void testRetrieval(s);
                                  }}
                                >
                                  <input aria-label="Test question for this source" data-testid="source-test-input" value={testQuestion} onChange={(e) => setTestQuestion(e.target.value)} placeholder="Ask something this website should be able to answer…" />
                                  <button className="btn primary" data-action="source-test" disabled={busy === `test:${s.id}` || !testQuestion.trim()}>
                                    {busy === `test:${s.id}` ? <span className="spin" /> : '⌕'} &nbsp; Test
                                  </button>
                                </form>
                                {retrieval && (
                                  <div data-testid="source-test-result" style={{ marginTop: 10 }}>
                                    <p className="tiny"><b>Answer:</b> {retrieval.answer}</p>
                                    <p className="tiny"><b>Citations:</b> {retrieval.citations.length ? retrieval.citations.map((c) => c.url ?? c.title).join(' · ') : 'none'}</p>
                                    {retrieval.retrievedSources.slice(0, 4).map((p, i) => (
                                      <div className="retrieval-card" key={i}>
                                        <b style={{ fontSize: 12 }}>{p.title}</b> <span className="fine">· {p.url} · score {p.score}</span>
                                        <p className="tiny">{p.snippet}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Indexed documents</h3>
                                <label className="fine">
                                  Show{' '}
                                  <select aria-label="Document status filter" value={docStatus} onChange={(e) => { setDocStatus(e.target.value); void loadDetail(s.id, 1, e.target.value); }}>
                                    <option value="">all</option>
                                    <option value="INDEXED">indexed</option>
                                    <option value="FAILED">failed</option>
                                    <option value="EXTRACTED">pending</option>
                                    <option value="ARCHIVED">archived</option>
                                  </select>
                                </label>
                                <div className="table-wrap">
                                  <table className="table" data-testid="source-docs">
                                    <thead><tr><th>Title</th><th>Status</th><th>Chunks</th><th>Words</th></tr></thead>
                                    <tbody>
                                      {detail.documents.map((d) => (
                                        <tr key={d.id}>
                                          <td><b>{d.title}</b><br /><span className="fine">{d.url}</span>{d.failureReason && <div className="err">{d.failureReason}</div>}</td>
                                          <td><span className={statusClass(d.status)}>{d.status.toLowerCase()}</span></td>
                                          <td>{d.chunks}</td>
                                          <td>{d.words}</td>
                                        </tr>
                                      ))}
                                      {detail.documents.length === 0 && <tr><td colSpan={4} className="fine">No documents.</td></tr>}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="fine">
                                  {detail.page.total} document{detail.page.total === 1 ? '' : 's'}
                                  {detail.page.total > detail.page.pageSize && (
                                    <>
                                      {' · page '}{detail.page.page}{' '}
                                      <button className="btn" disabled={detail.page.page <= 1} onClick={() => void loadDetail(s.id, detail.page.page - 1, docStatus)}>‹</button>{' '}
                                      <button className="btn" disabled={detail.page.page * detail.page.pageSize >= detail.page.total} onClick={() => void loadDetail(s.id, detail.page.page + 1, docStatus)}>›</button>
                                    </>
                                  )}
                                </div>

                                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Recent crawls</h3>
                                {detail.jobs.length === 0 && <div className="fine">No crawls yet.</div>}
                                {detail.jobs.map((j) => (
                                  <div className="retrieval-card" key={j.id}>
                                    <span className={statusClass(j.status)}>{j.status.toLowerCase()}</span>{' '}
                                    <span className="fine">
                                      {relativeTime(j.createdAt)} · {j.pagesProcessed} pages · {j.documentsCreated} new · {j.documentsUpdated} updated · {j.documentsSkipped} unchanged · {j.chunksIndexed} chunks
                                      {j.errorCount > 0 && ` · ${j.errorCount} failed`}
                                    </span>
                                    {j.error && <div className={j.status === 'FAILED' ? 'err' : 'info-note'} style={{ marginTop: 6 }}>{j.error}</div>}
                                    {j.problems.length > 0 && (
                                      <ul className="job-errors" style={{ listStyle: 'none' }}>
                                        {j.problems.slice(0, 8).map((p, i) => (
                                          <li key={i}><b>{p.level}</b> {p.message}{p.url && <span className="fine"> — {p.url}</span>}</li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel" id="jobsPanel">
        <div className="panel-head">
          <h2>Ingestion Jobs &amp; crawl history</h2>
          <span className="fine">{active ? 'Live — refreshing every 2s' : 'Idle'}</span>
        </div>

        {/* Work waiting with nobody to consume it looks identical to work about
            to start. Say so, rather than letting it read as progress. */}
        {queue?.enabled && queue.workers === 0 && queue.waiting > 0 && (
          <div className="empty warn" style={{ textAlign: 'left' }}>
            <b>
              {queue.waiting} job{queue.waiting === 1 ? '' : 's'} waiting, no worker running.
            </b>
            <div className="fine" style={{ marginTop: 4 }}>
              Jobs are handed to a separate ingestion worker instead of running in the web server.
              Start it with <code>npm run ingest:worker</code>, or check the hosted worker is running.
            </div>
          </div>
        )}

        {jobs.length === 0 && <div className="empty">No jobs yet.</div>}

        {jobs.map((job) => {
          const problems = (job.log ?? []).filter((l) => l.level === 'error' || l.level === 'warn');
          return (
            <div className="retrieval-card" key={job.id} data-job-id={job.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <b style={{ fontSize: 12 }}>
                  {job.sourceName ?? job.type.replace(/_/g, ' ').toLowerCase()}
                  <span className="fine"> · {job.type.replace(/_/g, ' ').toLowerCase()}</span>
                </b>
                <span className={statusClass(job.status)} data-testid="job-status">
                  {job.status.toLowerCase()}
                </span>
              </div>

              <StageRail job={job} compact />

              <p className="tiny" style={{ marginTop: 8 }}>
                {job.documentsCreated} new · {job.documentsUpdated} updated · {job.documentsSkipped} unchanged ·{' '}
                {job.chunksIndexed} chunks
                {job.errorCount > 0 && ` · ${job.errorCount} errors`}
                {' · '}
                {relativeTime(job.createdAt)}
              </p>
              {job.error && <div className="err" style={{ marginTop: 8 }}>{job.error}</div>}
              {problems.length > 0 && (
                <details className="job-errors">
                  <summary>
                    {problems.length} issue{problems.length === 1 ? '' : 's'} during this run
                  </summary>
                  <ul>
                    {problems.slice(0, 20).map((p, i) => (
                      <li key={i}>
                        <b>{p.level}</b> {p.message}
                        {p.url && <span className="fine"> — {p.url}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Five real stages; each reads the counters the backend wrote, never a timer. */
function StageRail({ job, compact }: { job: Job | null; compact?: boolean }) {
  const queued = job?.status === 'QUEUED';
  return (
    <div className={`pipeline${compact ? ' compact' : ''}`} data-testid="stage-rail">
      {STAGES.map((id) => {
        const stage = job?.progress?.stages[id];
        const state = stage?.state ?? 'pending';
        const total = stage?.total;
        let counts = '—';
        if (stage && (stage.state !== 'pending' || stage.done > 0)) {
          if (stage.state === 'skipped') counts = 'nothing to do';
          else if (id === 'discover') counts = `${stage.done} URLs`;
          else if (id === 'extract') counts = `${stage.done}${total != null ? ` / ${total}` : ''} pages`;
          else counts = `${stage.done}${total != null ? ` / ${total}` : ''} docs · ${stage.count} ${id === 'chunk' ? 'chunks' : 'vectors'}`;
          if (stage.errors > 0) counts += ` · ${stage.errors} failed`;
        } else if (queued) counts = 'waiting';
        return (
          <div className="pipeline-step" key={id} data-stage={id} data-state={state}>
            <span aria-hidden="true">{STAGE_META[id].icon}</span>
            {STAGE_META[id].label}
            <span className="st">{state}</span>
            {!compact && <span className="ct">{counts}</span>}
            {compact && <span className="ct" style={{ fontSize: 11 }}>{counts}</span>}
          </div>
        );
      })}
    </div>
  );
}
