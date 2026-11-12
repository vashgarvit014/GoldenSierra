import { getEmbeddingClient } from './client';
import { decorateQuery, localEmbed } from './local-embeddings';
import { env } from '../env';
import { withRetry } from '../errors';
import { logger } from '../logger';

/**
 * Embedding generation. Dimensions are asserted against the configured value
 * because a silent mismatch would corrupt the Qdrant collection.
 */

export type EmbeddingResult = { vector: number[]; model: string };

export function embeddingDimensions(): number {
  return env.EMBEDDING_DIMENSIONS;
}

/** `text-embedding-3-*` supports server-side truncation to a smaller size. */
function supportsDimensionParam(model: string) {
  return /^text-embedding-3/.test(model);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (env.EMBEDDING_PROVIDER === 'local') {
    const vectors = await localEmbed(texts.map(normalizeInput));
    assertDimensions(vectors, env.EMBEDDING_MODEL);
    return vectors;
  }

  const client = getEmbeddingClient();
  const model = env.EMBEDDING_MODEL;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += env.EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + env.EMBEDDING_BATCH_SIZE).map(normalizeInput);

    const response = await withRetry(
      () =>
        client.embeddings.create({
          model,
          input: batch,
          ...(supportsDimensionParam(model) ? { dimensions: env.EMBEDDING_DIMENSIONS } : {}),
        }),
      { attempts: 3, baseMs: 800, label: 'embeddings.create' },
    );

    // The API may return items out of order; `index` is authoritative.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((item) => item.embedding);
    assertDimensions(vectors, model);
    out.push(...vectors);

    logger.debug('Embedded batch', { from: i, size: batch.length, model });
  }

  return out;
}

/** Embeds a passage for indexing. */
export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error('Embedding provider returned no vector');
  return vector;
}

/**
 * Embeds a search query. Asymmetric models (the BGE family) expect an
 * instruction prefix on queries but not on passages; omitting it measurably
 * costs recall, so query embedding is a distinct call rather than a flag.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([decorateQuery(text)]);
  if (!vector) throw new Error('Embedding provider returned no vector');
  return vector;
}

/** A silent dimension mismatch would corrupt the collection, so fail loudly. */
function assertDimensions(vectors: number[][], model: string): void {
  for (const vector of vectors) {
    if (vector.length !== env.EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding dimension mismatch: model "${model}" returned ${vector.length} ` +
          `but EMBEDDING_DIMENSIONS is ${env.EMBEDDING_DIMENSIONS}. ` +
          `Fix the env value and re-index, or the vector store will reject writes.`,
      );
    }
  }
}

/** Empty strings are rejected by most providers; collapse whitespace too. */
function normalizeInput(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 8000) : '(empty)';
}

/** Rough token estimate used for chunk sizing and budget checks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
