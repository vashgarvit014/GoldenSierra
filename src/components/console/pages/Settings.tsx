'use client';

import { useEffect, useState } from 'react';
import { Head, useApi, useConsole } from '../Console';

type ConfigPayload = {
  effective: Record<string, number | boolean>;
  readOnly: Record<string, string | number | string[]>;
  chunkingAdvice: { chunkSize: number; chunkOverlap: number; rationale: string };
};

/** Only these are tunable at runtime; credentials never are. */
const FIELDS: { key: string; label: string; help: string; min: number; max: number; step: number }[] = [
  { key: 'RETRIEVAL_TOP_K', label: 'Candidates retrieved', help: 'Fetched before reranking. Higher recall, slower.', min: 4, max: 100, step: 1 },
  { key: 'RETRIEVAL_FINAL_K', label: 'Passages used', help: 'How many reach the model. Too many dilute the answer.', min: 1, max: 20, step: 1 },
  { key: 'RETRIEVAL_MIN_SCORE', label: 'Minimum similarity', help: 'Below this a passage is discarded.', min: 0, max: 1, step: 0.05 },
  { key: 'HYBRID_KEYWORD_WEIGHT', label: 'Keyword weight', help: 'Exact term overlap vs semantic similarity.', min: 0, max: 1, step: 0.05 },
  { key: 'CHUNK_SIZE', label: 'Chunk size (characters)', help: 'Applies to newly indexed documents — re-index to apply.', min: 200, max: 4000, step: 50 },
  { key: 'CHUNK_OVERLAP', label: 'Chunk overlap', help: 'Shared text between adjacent chunks. Re-index to apply.', min: 0, max: 800, step: 10 },
  { key: 'LLM_TEMPERATURE', label: 'Temperature', help: 'Keep low — workforce answers should be consistent.', min: 0, max: 2, step: 0.1 },
  { key: 'LLM_MAX_TOKENS', label: 'Max answer tokens', help: 'Reasoning models spend part of this budget thinking.', min: 200, max: 8000, step: 100 },
];

export function Settings() {
  const { notify } = useConsole();
  const { data, loading, error, reload } = useApi<ConfigPayload>('/api/admin/config');
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setValues(data.effective);
  }, [data]);

  const dirty = data && Object.keys(values).some((k) => values[k] !== data.effective[k]);

  async function save() {
    if (!data) return;
    setBusy(true);
    setSaveError(null);
    // Send only what changed, so opening this page never pins a default.
    const changed = Object.fromEntries(
      Object.keys(values).filter((k) => values[k] !== data.effective[k]).map((k) => [k, values[k]]),
    );
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed),
      });
      const body = (await res.json()) as { error?: string; note?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not save');
      notify(body.note ?? 'Settings saved');
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head
        eyebrow="CONFIGURATION"
        title="Settings"
        sub="Retrieval and generation tuning. Credentials stay in the environment."
        action={
          <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <span className="spin" /> : '✓'} &nbsp; Save changes
          </button>
        }
      />

      {error && <div className="err" style={{ marginBottom: 18 }}>{error}</div>}
      {saveError && <div className="err" style={{ marginBottom: 18 }}>{saveError}</div>}
      {loading && <div className="empty">Loading configuration…</div>}

      {data && (
        <>
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-head">
              <h2>Models and endpoints</h2>
              <span className="fine">Read-only — change in the environment and redeploy</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {Object.entries(data.readOnly).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ width: 240 }}><b>{k}</b></td>
                      <td style={{ wordBreak: 'break-all' }}>{Array.isArray(v) ? v.join(', ') : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="callout">
              API keys are never served over HTTP and cannot be edited here. Changing the embedding
              model requires a full re-index — dimensions must match the collection.
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Retrieval &amp; generation</h2>
              <span className="fine">Applies immediately</span>
            </div>

            <div className="upload-grid" style={{ marginBottom: 0 }}>
              {FIELDS.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={f.key}>
                    {f.label} <span className="muted">— {String(values[f.key] ?? '')}</span>
                  </label>
                  <input
                    id={f.key}
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={Number(values[f.key] ?? 0)}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                  />
                  <span className="info-note">{f.help}</span>
                </div>
              ))}

              <div className="field">
                <label htmlFor="RERANK_ENABLED">Reranking</label>
                <select
                  id="RERANK_ENABLED"
                  value={String(values.RERANK_ENABLED ?? true)}
                  onChange={(e) => setValues((v) => ({ ...v, RERANK_ENABLED: e.target.value === 'true' }))}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <span className="info-note">
                  Reorders candidates by relevance before generation. Costs latency; usually worth it.
                </span>
              </div>
            </div>

            <div className="callout">
              <b>Chunking advice for this embedding model:</b> {data.chunkingAdvice.rationale} Suggested
              size {data.chunkingAdvice.chunkSize}, overlap {data.chunkingAdvice.chunkOverlap}. Measure
              with the eval suite before changing, and re-index afterwards.
            </div>
          </div>
        </>
      )}
    </>
  );
}
