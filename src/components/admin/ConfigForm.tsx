'use client';

import { useState } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from '@/components/ui';

type Config = {
  RETRIEVAL_TOP_K: number;
  RETRIEVAL_FINAL_K: number;
  RETRIEVAL_MIN_SCORE: number;
  HYBRID_KEYWORD_WEIGHT: number;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  LLM_TEMPERATURE: number;
  LLM_MAX_TOKENS: number;
  RERANK_ENABLED: boolean;
};

const FIELDS: {
  key: keyof Config;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'RETRIEVAL_TOP_K', label: 'Candidates retrieved', help: 'Passages fetched before reranking. Higher recall, slower.', min: 4, max: 100, step: 1 },
  { key: 'RETRIEVAL_FINAL_K', label: 'Passages used', help: 'How many reach the model. Too many dilute the answer.', min: 1, max: 20, step: 1 },
  { key: 'RETRIEVAL_MIN_SCORE', label: 'Minimum similarity', help: 'Below this, a passage is discarded outright.', min: 0, max: 1, step: 0.05 },
  { key: 'HYBRID_KEYWORD_WEIGHT', label: 'Keyword weight', help: 'How much exact term overlap counts against semantic similarity.', min: 0, max: 1, step: 0.05 },
  { key: 'CHUNK_SIZE', label: 'Chunk size (characters)', help: 'Applies to newly indexed documents only — re-index to apply.', min: 200, max: 4000, step: 50 },
  { key: 'CHUNK_OVERLAP', label: 'Chunk overlap', help: 'Shared text between adjacent chunks. Re-index to apply.', min: 0, max: 800, step: 10 },
  { key: 'LLM_TEMPERATURE', label: 'Temperature', help: 'Keep low. Workforce answers should be consistent, not creative.', min: 0, max: 2, step: 0.1 },
  { key: 'LLM_MAX_TOKENS', label: 'Max answer tokens', help: 'Hard ceiling on answer length.', min: 200, max: 8000, step: 100 },
];

export function ConfigForm({ initial, canEdit }: { initial: Config; canEdit: boolean }) {
  const [values, setValues] = useState<Config>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dirty = (Object.keys(values) as (keyof Config)[]).some((k) => values[k] !== initial[k]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);

    // Send only what changed, so an unrelated default is never pinned as an
    // override by the act of opening this page.
    const changed = Object.fromEntries(
      (Object.keys(values) as (keyof Config)[])
        .filter((k) => values[k] !== initial[k])
        .map((k) => [k, values[k]]),
    );

    try {
      const response = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed),
      });
      const data = (await response.json()) as { error?: string; note?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not save');
      setSaved(data.note ?? 'Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retrieval and generation tuning</CardTitle>
        {!canEdit && (
          <p className="mt-1 text-xs text-muted">
            Read-only — changing these requires the admin role.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium">{field.label}</span>
                <span className="font-mono text-xs text-muted">{String(values[field.key])}</span>
              </span>
              <Input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                disabled={!canEdit}
                value={Number(values[field.key])}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [field.key]: Number(e.target.value) }))
                }
              />
              <span className="mt-1 block text-xs text-muted">{field.help}</span>
            </label>
          ))}

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={values.RERANK_ENABLED}
              onChange={(e) => setValues((v) => ({ ...v, RERANK_ENABLED: e.target.checked }))}
              className="mt-0.5"
            />
            <span>
              <span className="block text-xs font-medium">Reranking enabled</span>
              <span className="block text-xs text-muted">
                Reorders candidates by relevance before generation. Costs latency; usually worth it.
              </span>
            </span>
          </label>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="success">{saved}</Alert>}

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} disabled={busy || !dirty} size="sm">
              {busy && <Spinner />}
              Save changes
            </Button>
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setValues(initial)}>
                Reset
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
