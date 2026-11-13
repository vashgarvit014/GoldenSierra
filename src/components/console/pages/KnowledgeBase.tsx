'use client';

import { useRef, useState } from 'react';
import { Head, useApi, useConsole } from '../Console';
import { relativeTime } from './Overview';

type DocRow = {
  id: string;
  title: string;
  url: string | null;
  type: string;
  status: string;
  category: string | null;
  audience: string | null;
  counties: string[];
  wordCount: number;
  chunkCount: number;
  language: string;
  failureReason: string | null;
  updatedAt: string;
  source: { id: string; name: string } | null;
};

type DocsPayload = { total: number; page: number; pageSize: number; documents: DocRow[] };

const AUDIENCES = ['', 'job_seeker', 'employer', 'both', 'agency'];
const CATEGORIES = [
  '',
  'job_search',
  'training',
  'financial_assistance',
  'career_counseling',
  'internships',
  'employer_services',
  'employer_incentives',
  'eligibility',
  'events',
  'contact',
  'policy',
  'general',
];

export function KnowledgeBase() {
  const { notify } = useConsole();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading, error, reload } = useApi<DocsPayload>(
    `/api/admin/documents?pageSize=50${query ? `&search=${encodeURIComponent(query)}` : ''}`,
    [query],
  );

  // Upload state
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [audience, setAudience] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setProgress(10);
    setProgressLabel('Uploading…');

    const form = new FormData();
    form.append('file', file);
    if (audience) form.append('audience', audience);
    if (category) form.append('category', category);

    // The API is a single call that extracts, chunks, embeds and indexes, so
    // the bar reflects stages rather than bytes — honest about what it knows.
    const stages = [
      [30, 'Extracting text…'],
      [55, 'Chunking…'],
      [78, 'Generating embeddings…'],
      [92, 'Writing to the vector store…'],
    ] as const;
    let i = 0;
    const tick = setInterval(() => {
      if (i < stages.length) {
        setProgress(stages[i]![0]);
        setProgressLabel(stages[i]![1]);
        i++;
      }
    }, 700);

    try {
      const res = await fetch('/api/admin/documents/upload', { method: 'POST', body: form });
      const body = (await res.json()) as {
        error?: string;
        action?: string;
        chunksIndexed?: number;
        reason?: string;
      };
      clearInterval(tick);
      if (!res.ok) throw new Error(body.error ?? 'Upload failed');

      setProgress(100);
      setProgressLabel('Indexed');
      setResult({
        ok: true,
        text: `${file.name}: ${body.action}, ${body.chunksIndexed ?? 0} chunks indexed.`,
      });
      notify(`${file.name} indexed — ${body.chunksIndexed ?? 0} chunks`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (err) {
      clearInterval(tick);
      setProgress(0);
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, label: string) {
    const res = await fetch(`/api/admin/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, reindex: true }),
    });
    const json = (await res.json()) as { error?: string; chunks?: number };
    if (!res.ok) {
      notify(json.error ?? 'Update failed');
      return;
    }
    notify(`${label} — re-indexed ${json.chunks ?? 0} chunks`);
    await reload();
  }

  async function archive(doc: DocRow) {
    if (!confirm(`Archive "${doc.title}"?\n\nIts vectors are removed so it stops appearing in answers. The record is kept.`)) {
      return;
    }
    const res = await fetch(`/api/admin/documents/${doc.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      notify(body.error ?? 'Could not archive');
      return;
    }
    notify(`${doc.title} archived and removed from the index`);
    await reload();
  }

  return (
    <>
      <Head
        eyebrow="KNOWLEDGE MANAGEMENT"
        title="Knowledge Base"
        sub="Upload documents and manage what the assistant can retrieve."
        action={
          <button className="btn" onClick={() => void reload()}>
            ↻ &nbsp; Refresh
          </button>
        }
      />

      <div className="upload-grid">
        <div
          className="drop"
          id="drop"
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
        >
          <div className="upload-icon" aria-hidden="true">
            ⇪
          </div>
          <b id="dropTitle">{file ? file.name : 'Drop a PDF here, or click to browse'}</b>
          <span id="fileName">
            {file
              ? `${(file.size / 1024).toFixed(0)} KB — ready to index`
              : 'PDF only · up to 20 MB · text-based (scanned files need OCR first)'}
          </span>
          <input
            ref={fileRef}
            id="pdfInput"
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Classification</h2>
            <span className="fine">Optional</span>
          </div>

          <div className="field">
            <label htmlFor="audience">Audience</label>
            <select id="audience" value={audience} onChange={(e) => setAudience(e.target.value)}>
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {a ? a.replace(/_/g, ' ') : 'Detect automatically'}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="category">Category</label>
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c ? c.replace(/_/g, ' ') : 'Detect automatically'}
                </option>
              ))}
            </select>
          </div>

          <p className="info-note">
            Audience is a hard retrieval filter. Automatic detection reads the document&apos;s
            wording — a job-listings table full of the word “Employer” can be labelled{' '}
            <b>employer</b> and then stay hidden from job seekers. Set it explicitly when you know.
          </p>

          <button className="btn primary" style={{ marginTop: 14 }} disabled={!file || busy} onClick={() => void upload()}>
            {busy ? <span className="spin" /> : '⇪'} &nbsp; Upload &amp; index
          </button>

          <div id="uploadState" className={`progress-shell${busy || progress ? ' show' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span id="progressLabel">{progressLabel}</span>
              <span>{progress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" id="progressFill" style={{ width: `${progress}%` }} />
            </div>
            <div id="uploadNote" className="info-note">
              Extraction, chunking, embedding and indexing all happen in this one request.
            </div>
          </div>

          {result && (
            <div className={result.ok ? 'ok' : 'err'} style={{ marginTop: 12 }}>
              {result.text}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Indexed Documents</h2>
          <form
            className="question-box"
            style={{ maxWidth: 360 }}
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
            }}
          >
            <input
              placeholder="Search title or URL…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn">Search</button>
          </form>
        </div>

        {error && <div className="err">{error}</div>}
        {loading && <div className="empty">Loading documents…</div>}
        {!loading && data?.documents.length === 0 && (
          <div className="empty">No documents yet. Upload a PDF or run a crawl.</div>
        )}

        {!loading && !!data?.documents.length && (
          <>
            <p className="fine" style={{ marginBottom: 10 }}>
              Showing {data.documents.length} of {data.total}
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Type</th>
                    <th>Audience</th>
                    <th>Category</th>
                    <th>Chunks</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody id="documentRows">
                  {data.documents.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <b>{d.title}</b>
                        {d.url && (
                          <>
                            <br />
                            <span className="fine">{d.url.replace(/^https?:\/\//, '')}</span>
                          </>
                        )}
                        {d.failureReason && (
                          <>
                            <br />
                            <span style={{ color: '#9c3434', fontSize: 11 }}>{d.failureReason}</span>
                          </>
                        )}
                      </td>
                      <td>{d.type === 'PDF' ? '📄 PDF' : '🌐 Page'}</td>
                      <td>
                        <select
                          value={d.audience ?? ''}
                          onChange={(e) =>
                            void patch(d.id, { audience: e.target.value }, `${d.title} → ${e.target.value}`)
                          }
                          style={{ height: 32, borderRadius: 7, border: '1px solid #dce4eb', padding: '0 7px', fontSize: 11 }}
                        >
                          {AUDIENCES.filter(Boolean).map((a) => (
                            <option key={a} value={a}>
                              {a.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className="tag">{d.category ?? '—'}</span>
                      </td>
                      <td>{d.chunkCount}</td>
                      <td>
                        <span
                          className={`status${
                            d.status === 'INDEXED' ? '' : d.status === 'FAILED' ? ' warn' : ' gray'
                          }`}
                        >
                          {d.status.toLowerCase()}
                        </span>
                      </td>
                      <td className="fine">{relativeTime(d.updatedAt)}</td>
                      <td>
                        <button className="btn ghost" onClick={() => void archive(d)}>
                          Archive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="callout">
          Changing audience or category re-indexes the document immediately — the value lives in
          the vector payload, so a database-only edit would not change retrieval.
        </div>
      </div>
    </>
  );
}
