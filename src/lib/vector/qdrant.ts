import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../env';
import { embeddingDimensions } from '../ai/embeddings';
import { logger } from '../logger';
import { withRetry } from '../errors';
import { createHash } from 'node:crypto';

/**
 * Qdrant holds embeddings plus a compact copy of the metadata needed to filter
 * them. Postgres remains the system of record; every point carries `chunkId`
 * and `documentId` so the two stores can always be reconciled.
 */

export type VectorPayload = {
  chunkId: string;
  documentId: string;
  title: string;
  url: string | null;
  content: string;
  headingPath: string | null;
  /** Document-level classification. */
  category: string | null;
  /**
   * Classification of this chunk alone, from its heading and text. A service
   * hub page is one document with one category, but its sections answer
   * different questions — the "Apply for a Scholarship" section of a page
   * categorised `job_search` is the best answer to a funding question. Ranking
   * on the document category alone systematically buries it.
   */
  chunkCategory: string | null;
  /** Rough information density; used to down-rank hero/marketing copy. */
  informative: boolean;
  audience: string | null;
  programName: string | null;
  counties: string[];
  tags: string[];
  documentType: string;
  accessLevel: string;
  language: string;
  publishedAt: string | null;
  lastVerifiedAt: string | null;
  version: number;
  ordinal: number;
};

export type VectorHit = { id: string; score: number; payload: VectorPayload };

let client: QdrantClient | undefined;

export function getQdrant(): QdrantClient {
  client ??= new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY || undefined,
    checkCompatibility: false,
  });
  return client;
}

export const COLLECTION = env.QDRANT_COLLECTION;

/**
 * Creates the collection when missing and installs payload indexes for every
 * field we filter on — without these, filtered search degrades to a full scan.
 */
export async function ensureCollection(): Promise<{ created: boolean; dimensions: number }> {
  const qdrant = getQdrant();
  const dimensions = embeddingDimensions();

  const { collections } = await qdrant.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: dimensions, distance: 'Cosine' },
      optimizers_config: { default_segment_number: 2 },
      on_disk_payload: true,
    });
    logger.info('Created Qdrant collection', { collection: COLLECTION, dimensions });
  } else {
    // Guard against an embedding-model change that silently breaks search.
    const info = await qdrant.getCollection(COLLECTION);
    const params = info.config?.params?.vectors;
    const existingSize =
      typeof params === 'object' && params && 'size' in params ? Number(params.size) : undefined;
    if (existingSize && existingSize !== dimensions) {
      throw new Error(
        `Qdrant collection "${COLLECTION}" has ${existingSize}-dimensional vectors but the ` +
          `configured embedding model produces ${dimensions}. Either restore the previous ` +
          `EMBEDDING_MODEL/EMBEDDING_DIMENSIONS, or use a new QDRANT_COLLECTION name and re-index.`,
      );
    }
  }

  for (const field of [
    'documentId',
    'chunkId',
    'category',
    'audience',
    'programName',
    'counties',
    'tags',
    'documentType',
    'accessLevel',
    'language',
  ]) {
    try {
      await qdrant.createPayloadIndex(COLLECTION, { field_name: field, field_schema: 'keyword' });
    } catch {
      // Already present — Qdrant errors rather than treating this as a no-op.
    }
  }

  // Full-text indexes. `match: { text }` in the keyword retriever requires
  // these; without them Qdrant rejects the query outright.
  for (const field of ['content', 'title']) {
    try {
      await qdrant.createPayloadIndex(COLLECTION, {
        field_name: field,
        field_schema: {
          type: 'text',
          tokenizer: 'word',
          min_token_len: 2,
          max_token_len: 30,
          lowercase: true,
        },
      });
    } catch {
      // Already present.
    }
  }

  return { created: !exists, dimensions };
}

/**
 * Qdrant point ids must be an unsigned integer or a UUID — our chunk ids are
 * cuids. This maps a chunk id onto a stable UUIDv5-shaped value so the same
 * chunk always lands on the same point, making re-indexing idempotent.
 */
export function pointIdForChunk(chunkId: string): string {
  const h = createHash('sha1').update(`gs-chunk:${chunkId}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type UpsertPoint = { id: string; vector: number[]; payload: VectorPayload };

export async function upsertPoints(points: UpsertPoint[]): Promise<void> {
  if (points.length === 0) return;
  const qdrant = getQdrant();
  const BATCH = 100;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    await withRetry(
      () =>
        qdrant.upsert(COLLECTION, {
          wait: true,
          points: batch.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload as never })),
        }),
      { attempts: 3, baseMs: 600, label: 'qdrant.upsert' },
    );
  }
  logger.debug('Upserted vectors', { count: points.length });
}

export type SearchFilters = {
  categories?: string[];
  audiences?: string[];
  counties?: string[];
  documentTypes?: string[];
  programNames?: string[];
  /** Omit to restrict to PUBLIC — the safe default for end users. */
  accessLevels?: string[];
  language?: string;
};

function buildFilter(filters: SearchFilters) {
  const must: Record<string, unknown>[] = [];

  // Access level is always constrained; an unauthenticated chat user may only
  // ever reach PUBLIC material.
  must.push({ key: 'accessLevel', match: { any: filters.accessLevels ?? ['PUBLIC'] } });

  if (filters.language) must.push({ key: 'language', match: { value: filters.language } });
  if (filters.categories?.length) must.push({ key: 'category', match: { any: filters.categories } });
  if (filters.audiences?.length) must.push({ key: 'audience', match: { any: filters.audiences } });
  if (filters.documentTypes?.length)
    must.push({ key: 'documentType', match: { any: filters.documentTypes } });
  if (filters.programNames?.length)
    must.push({ key: 'programName', match: { any: filters.programNames } });

  // NOTE: county is deliberately NOT a filter clause.
  //
  // Qdrant treats a `should` array as requiring at least one match when it is
  // present, so expressing "prefer Placer" as a `should` would in fact exclude
  // every agency-wide page that names no county — which is most of the corpus.
  // The county preference is applied as a ranking boost after retrieval
  // instead (see `retrieve()`), which is what "soft" actually requires.

  return { must };
}

export async function searchVectors(
  vector: number[],
  limit: number,
  filters: SearchFilters = {},
  minScore?: number,
): Promise<VectorHit[]> {
  const qdrant = getQdrant();
  // Qdrant's Query API supersedes the removed `search` method.
  const response = await withRetry(
    () =>
      qdrant.query(COLLECTION, {
        query: vector,
        limit,
        filter: buildFilter(filters) as never,
        with_payload: true,
        score_threshold: minScore,
      }),
    { attempts: 2, baseMs: 400, label: 'qdrant.query' },
  );

  return response.points.map((hit) => ({
    id: String(hit.id),
    score: hit.score ?? 0,
    payload: hit.payload as unknown as VectorPayload,
  }));
}

/** Keyword/phrase match over stored chunk text, used by the hybrid retriever. */
export async function scrollByKeywords(
  phrases: string[],
  limit: number,
  filters: SearchFilters = {},
): Promise<VectorHit[]> {
  if (phrases.length === 0) return [];
  const qdrant = getQdrant();
  const base = buildFilter(filters);

  // Here `should` is exactly right: a result must satisfy the access/audience
  // constraints in `must` AND match at least one of the phrases.
  const response = await qdrant.scroll(COLLECTION, {
    limit,
    with_payload: true,
    filter: {
      ...base,
      should: phrases.flatMap((phrase) => [
        { key: 'content', match: { text: phrase } },
        { key: 'title', match: { text: phrase } },
      ]),
    } as never,
  });

  return response.points.map((point) => ({
    id: String(point.id),
    score: 0, // Keyword hits carry no similarity score; the fuser assigns rank.
    payload: point.payload as unknown as VectorPayload,
  }));
}

/** Removes every vector belonging to a document. Called on delete/archive and
 *  before re-indexing, so withdrawn content cannot survive in the index. */
export async function deleteByDocument(documentId: string): Promise<void> {
  const qdrant = getQdrant();
  await withRetry(
    () =>
      qdrant.delete(COLLECTION, {
        wait: true,
        filter: { must: [{ key: 'documentId', match: { value: documentId } }] } as never,
      }),
    { attempts: 3, baseMs: 500, label: 'qdrant.deleteByDocument' },
  );
  logger.info('Deleted vectors for document', { documentId });
}

export async function deleteByChunkIds(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  const qdrant = getQdrant();
  await qdrant.delete(COLLECTION, { wait: true, points: chunkIds.map(pointIdForChunk) });
}

export async function collectionStats(): Promise<{
  exists: boolean;
  vectorCount: number;
  indexedCount: number;
  dimensions: number | null;
  status: string | null;
}> {
  try {
    const qdrant = getQdrant();
    const info = await qdrant.getCollection(COLLECTION);
    const params = info.config?.params?.vectors;
    return {
      exists: true,
      vectorCount: info.points_count ?? 0,
      indexedCount: info.indexed_vectors_count ?? 0,
      dimensions:
        typeof params === 'object' && params && 'size' in params ? Number(params.size) : null,
      status: info.status ?? null,
    };
  } catch {
    return { exists: false, vectorCount: 0, indexedCount: 0, dimensions: null, status: null };
  }
}

export async function qdrantHealthy(): Promise<boolean> {
  try {
    await getQdrant().getCollections();
    return true;
  } catch {
    return false;
  }
}
