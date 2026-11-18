/**
 * OpenAI-compatible embedding service for hosts that cannot run the model in-process (Vercel).
 * Runs the same Transformers.js model, quantisation and pooling as src/lib/ai/local-embeddings.ts,
 * so its vectors match the local index exactly.
 *
 *   POST /v1/embeddings  { input: string | string[] }  (Authorization: Bearer $API_KEY)
 *   GET  /health
 */
import http from 'node:http';
import { pipeline, env } from '@huggingface/transformers';

const MODEL = process.env.MODEL_ID ?? 'Xenova/bge-small-en-v1.5';
const API_KEY = process.env.API_KEY;
const PORT = Number(process.env.PORT ?? 8080);
const BATCH = 16;
const MAX_INPUTS = 256;
env.cacheDir = process.env.MODEL_CACHE ?? '/app/.cache';

const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
await extractor(['warmup'], { pooling: 'mean', normalize: true });
console.log(`model ready: ${MODEL}`);

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await extractor(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
    out.push(...r.tolist());
  }
  return out;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL });
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/embeddings')) return send(res, 404, { error: 'not found' });
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return send(res, 401, { error: 'unauthorized' });

      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4_000_000) return send(res, 413, { error: 'payload too large' });
      }
      const { input } = JSON.parse(raw || '{}');
      const texts = typeof input === 'string' ? [input] : input;
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_INPUTS || !texts.every((t) => typeof t === 'string')) {
        return send(res, 400, { error: `input must be a string or 1-${MAX_INPUTS} strings` });
      }
      const vectors = await embed(texts);
      send(res, 200, {
        object: 'list',
        model: MODEL,
        data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: 'embedding failed' });
    }
  })
  .listen(PORT, () => console.log(`listening on ${PORT}`));
