import { env } from '../env';
import { logger } from '../logger';

/**
 * In-process embeddings via Transformers.js (ONNX runtime, CPU).
 *
 * Why this exists: Inception Labs — the configured chat provider — serves only
 * `chat.completions` and has no embeddings endpoint. Rather than require a
 * second paid provider just to vectorise a few hundred pages, the BGE family
 * runs locally. The brief named BGE-M3 as a preferred embedding model, and
 * BGE-small-en-v1.5 is the same family sized for a corpus this small: 384
 * dimensions, ~33MB quantised, strong on short-passage retrieval.
 *
 * Trade-offs, stated plainly:
 *  - First call downloads the model (~33MB) and takes a few seconds. It is
 *    cached under node_modules/.cache afterwards.
 *  - Throughput is CPU-bound. Fine for indexing a few hundred documents and
 *    for per-query embedding; not what you would choose for millions of docs.
 *  - Switching to a hosted embedding provider is an env change plus a
 *    re-index — see EMBEDDING_PROVIDER in .env.example.
 */

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= (async () => {
    const started = Date.now();
    // Imported lazily so the package is never loaded in a deployment that
    // uses a hosted embedding provider.
    const { pipeline, env: hfEnv } = await import('@huggingface/transformers');

    // Allow remote download on first use, then serve from the local cache.
    hfEnv.allowLocalModels = true;

    const extractor = (await pipeline('feature-extraction', env.EMBEDDING_MODEL, {
      dtype: 'q8',
    })) as unknown as FeatureExtractionPipeline;

    logger.info('Local embedding model ready', {
      model: env.EMBEDDING_MODEL,
      loadMs: Date.now() - started,
    });
    return extractor;
  })();

  return pipelinePromise;
}

/**
 * BGE models are trained asymmetrically: queries are prefixed with an
 * instruction, passages are not. Skipping this measurably degrades recall,
 * so it is applied automatically rather than left to callers.
 */
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

function isBge(model: string): boolean {
  return /bge/i.test(model);
}

export function decorateQuery(text: string): string {
  return isBge(env.EMBEDDING_MODEL) ? `${BGE_QUERY_PREFIX}${text}` : text;
}

export async function localEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();

  const out: number[][] = [];
  // Smaller batches than a hosted API: this is CPU work, and a huge batch
  // would hold the event loop for seconds at a time.
  const BATCH = Math.min(env.EMBEDDING_BATCH_SIZE, 16);

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const result = await extractor(batch, { pooling: 'mean', normalize: true });
    out.push(...result.tolist());

    // Yield between batches so a long indexing run does not starve the
    // server's other requests.
    if (i + BATCH < texts.length) await new Promise((r) => setImmediate(r));
  }

  return out;
}

/** Warms the model so the first user question does not pay the load cost. */
export async function warmLocalEmbeddings(): Promise<void> {
  try {
    await localEmbed(['warmup']);
  } catch (err) {
    logger.warn('Could not warm the local embedding model', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
