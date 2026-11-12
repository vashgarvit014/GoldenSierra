'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from '@/components/ui';
import { relativeTime } from '@/lib/utils';

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
  lastJob: { id: string; status: string; type: string } | null;
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

export function SourcesManager({ canEdit }: { canEdit: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sourcesRes, statusRes] = await Promise.all([
        fetch('/api/admin/sources'),
        fetch('/api/admin/ingestion/status'),
      ]);
      if (sourcesRes.ok) setSources(((await sourcesRes.json()) as { sources: Source[] }).sources);
      if (statusRes.ok) setJobs(((await statusRes.json()) as { jobs: Job[] }).jobs);
    } catch {
      setError('Could not load sources.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while something is actually running, so an idle dashboard is
  // not making a request every few seconds.
  const hasActiveJob = jobs.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
  useEffect(() => {
    if (hasActiveJob && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 3000);
    } else if (!hasActiveJob && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasActiveJob, refresh]);

  async function startJob(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: string; jobId?: string; mode?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not start the job');
      setNotice(
        data.mode === 'queued'
          ? 'Queued. A worker will pick it up.'
          : 'Running in this process — progress updates below.',
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the job');
    } finally {
      setBusy(null);
    }
  }

  async function removeSource(id: string, name: string) {
    if (!confirm(`Remove "${name}"?\n\nIts documents are kept and stay searchable. Delete them separately if they should be withdrawn.`)) {
      return;
    }
    setBusy(id);
    try {
      const response = await fetch(`/api/admin/sources/${id}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string; note?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not remove the source');
      setNotice(data.note ?? 'Source removed.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the source');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Loading sources…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Knowledge sources</h1>
          <p className="text-sm text-muted">
            Only hosts listed in <code className="font-mono text-xs">CRAWL_ALLOWED_HOSTS</code> can
            be indexed.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowAdd((v) => !v)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add source
            </Button>
            <Button
              size="sm"
              onClick={() => void startJob({ type: 'REINDEX' }, 'reindex')}
              disabled={busy === 'reindex'}
              title="Re-embed every document — needed after an embedding model change"
            >
              {busy === 'reindex' ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              Re-index all
            </Button>
          </div>
        )}
      </div>

      {showAdd && canEdit && <AddSourceForm onDone={() => { setShowAdd(false); void refresh(); }} />}
      {canEdit && <UploadPdf onDone={() => void refresh()} />}

      <div className="space-y-3">
        {sources.length === 0 && (
          <Card>
            <CardContent className="pt-5 text-sm text-muted">
              No sources configured. Run <code className="font-mono">npm run db:seed</code> to add
              the Golden Sierra defaults, or add one above.
            </CardContent>
          </Card>
        )}

        {sources.map((source) => (
          <Card key={source.id}>
            <CardContent className="pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium">{source.name}</h3>
                    <Badge tone={source.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {source.status.toLowerCase()}
                    </Badge>
                  </div>
                  {source.rootUrl && (
                    <a
                      href={source.rootUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-sierra-700 hover:underline dark:text-sierra-300"
                    >
                      {source.rootUrl}
                    </a>
                  )}
                  <p className="mt-1 text-xs text-muted">
                    {source.documentCount} documents · depth {source.maxDepth} · max{' '}
                    {source.maxPages} pages ·{' '}
                    {source.respectRobots ? 'respects robots.txt' : 'robots.txt ignored'}
                  </p>
                  <p className="text-xs text-muted">
                    Last crawled {relativeTime(source.lastCrawledAt)}
                  </p>
                  {source.excludePatterns.length > 0 && (
                    <p className="mt-1 font-mono text-[11px] text-muted">
                      excludes: {source.excludePatterns.join('  ')}
                    </p>
                  )}
                </div>

                {canEdit && source.rootUrl && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === source.id}
                      onClick={() => void startJob({ type: 'CRAWL', sourceId: source.id }, source.id)}
                    >
                      {busy === source.id ? <Spinner /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                      Crawl
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${source.name}`}
                      disabled={busy === source.id}
                      onClick={() => void removeSource(source.id, source.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ingestion jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {jobs.map((job) => (
                <li key={job.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {job.sourceName ?? job.type.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="text-xs text-muted">
                      {job.status === 'RUNNING'
                        ? `${job.pagesProcessed} of ${job.pagesDiscovered} pages…`
                        : `${job.documentsCreated} new · ${job.documentsUpdated} updated · ${job.documentsSkipped} unchanged · ${job.chunksIndexed} chunks`}
                      {job.errorCount > 0 && ` · ${job.errorCount} errors`}
                    </p>
                    {job.error && <p className="mt-0.5 text-xs text-red-600">{job.error}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge
                      tone={
                        job.status === 'COMPLETED'
                          ? 'success'
                          : job.status === 'FAILED'
                            ? 'danger'
                            : job.status === 'RUNNING'
                              ? 'info'
                              : 'neutral'
                      }
                    >
                      {job.status.toLowerCase()}
                    </Badge>
                    <p className="mt-0.5 text-xs text-muted">{relativeTime(job.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [rootUrl, setRootUrl] = useState('');
  const [maxPages, setMaxPages] = useState(100);
  const [maxDepth, setMaxDepth] = useState(3);
  const [excludes, setExcludes] = useState('/blog/document/, /(es|ru|fa|uk)(/|$)');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type: 'WEBSITE',
          rootUrl,
          maxPages,
          maxDepth,
          respectRobots: true,
          excludePatterns: excludes.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not add the source');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the source');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a website source</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
            </Field>
            <Field label="Root URL">
              <Input
                type="url"
                value={rootUrl}
                onChange={(e) => setRootUrl(e.target.value)}
                placeholder="https://goldensierra.com/"
                required
              />
            </Field>
            <Field label="Max pages">
              <Input
                type="number"
                min={1}
                max={2000}
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
              />
            </Field>
            <Field label="Max depth">
              <Input
                type="number"
                min={0}
                max={6}
                value={maxDepth}
                onChange={(e) => setMaxDepth(Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Exclude patterns (comma-separated regular expressions)">
            <Input value={excludes} onChange={(e) => setExcludes(e.target.value)} />
          </Field>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Spinner />}
            Add source
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function UploadPdf({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append('file', file);

    try {
      const response = await fetch('/api/admin/documents/upload', { method: 'POST', body: form });
      const data = (await response.json()) as {
        error?: string;
        action?: string;
        chunksIndexed?: number;
      };
      if (!response.ok) throw new Error(data.error ?? 'Upload failed');
      setResult(`${file.name}: ${data.action}, ${data.chunksIndexed ?? 0} chunks indexed.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a PDF</CardTitle>
        <p className="mt-1 text-xs text-muted">
          Text is extracted and indexed immediately. Scanned PDFs with no text layer are rejected.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-sierra-700 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-sierra-800"
          />
          {busy && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Spinner />
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              Extracting…
            </span>
          )}
        </div>
        {result && <Alert tone="success" className="mt-3">{result}</Alert>}
        {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}
