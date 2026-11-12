import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import {
  deleteByDocument,
  pointIdForChunk,
  searchVectors,
  scrollByKeywords,
  upsertPoints,
  type VectorPayload,
} from '@/lib/vector/qdrant';
import { env } from '@/lib/env';

/**
 * Exercises the real Qdrant instance — not a mock — because the properties
 * that matter here are properties of the store: that metadata filters
 * actually exclude, that access level is enforced, and that deleting a
 * document really removes its vectors.
 *
 * Embeddings are produced by a deterministic local function rather than a
 * provider API. The vectors are meaningless as semantics, which is the point:
 * these tests verify storage, filtering and lifecycle, not retrieval quality.
 * Answer quality is measured by the eval harness (`npm run eval`), which does
 * need a real model.
 *
 * Skipped automatically when Qdrant is not reachable, so `npm test` still
 * passes on a machine with no services running.
 */

const COLLECTION = `${env.QDRANT_COLLECTION}_test`;
const DIMENSIONS = env.EMBEDDING_DIMENSIONS;

/** Deterministic pseudo-embedding: same text always yields the same vector. */
function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    const digest = createHash('sha256').update(word).digest();
    for (let i = 0; i < 8; i++) {
      const slot = ((digest[i]! << 8) | digest[i + 8]!) % DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function payload(overrides: Partial<VectorPayload> & { chunkId: string }): VectorPayload {
  return {
    documentId: 'doc-1',
    title: 'Test page',
    url: 'https://goldensierra.com/test',
    content: 'Training scholarships and tuition assistance for approved programs.',
    headingPath: null,
    category: 'financial_assistance',
    audience: 'job_seeker',
    programName: null,
    counties: ['Placer'],
    tags: [],
    documentType: 'WEB_PAGE',
    accessLevel: 'PUBLIC',
    language: 'en',
    publishedAt: null,
    lastVerifiedAt: null,
    version: 1,
    ordinal: 0,
    ...overrides,
  };
}

let available = false;
let client: QdrantClient;

// The module under test is bound to env.QDRANT_COLLECTION, so the suite runs
// against that collection and cleans up the documents it creates.
const DOC_A = 'test-doc-a';
const DOC_B = 'test-doc-b';
const DOC_INTERNAL = 'test-doc-internal';

beforeAll(async () => {
  client = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY || undefined, checkCompatibility: false });
  try {
    await client.getCollections();
    available = true;
  } catch {
    available = false;
    return;
  }

  const { ensureCollection } = await import('@/lib/vector/qdrant');
  await ensureCollection();

  // Clean any residue from an earlier run before seeding.
  for (const id of [DOC_A, DOC_B, DOC_INTERNAL]) await deleteByDocument(id);

  await upsertPoints([
    {
      id: pointIdForChunk('chunk-a1'),
      vector: fakeEmbed('training scholarships tuition assistance placer'),
      payload: payload({
        chunkId: 'chunk-a1',
        documentId: DOC_A,
        title: 'Help for Job Seekers',
        content: 'Training scholarships and tuition assistance are available in Placer County.',
        category: 'financial_assistance',
        audience: 'job_seeker',
        counties: ['Placer'],
      }),
    },
    {
      id: pointIdForChunk('chunk-b1'),
      vector: fakeEmbed('employer wage reimbursement on the job training'),
      payload: payload({
        chunkId: 'chunk-b1',
        documentId: DOC_B,
        title: 'Help for Employers',
        content: 'Employers may receive wage reimbursement through on-the-job training.',
        category: 'employer_incentives',
        audience: 'employer',
        counties: ['Alpine'],
        programName: 'On-the-Job Training',
      }),
    },
    {
      id: pointIdForChunk('chunk-i1'),
      vector: fakeEmbed('internal staff only procedure document'),
      payload: payload({
        chunkId: 'chunk-i1',
        documentId: DOC_INTERNAL,
        title: 'Internal procedure',
        content: 'Internal staff only procedure document.',
        accessLevel: 'INTERNAL',
      }),
    },
  ]);
});

afterAll(async () => {
  if (!available) return;
  for (const id of [DOC_A, DOC_B, DOC_INTERNAL]) await deleteByDocument(id);
});

describe.runIf(process.env.SKIP_INTEGRATION !== 'true')('Qdrant integration', () => {
  it('stores and retrieves a vector by similarity', async ({ skip }) => {
    if (!available) return skip();

    const results = await searchVectors(fakeEmbed('training scholarships tuition assistance placer'), 10);
    expect(results.some((r) => r.payload.chunkId === 'chunk-a1')).toBe(true);
  });

  it('excludes INTERNAL documents from a default (public) search', async ({ skip }) => {
    if (!available) return skip();

    // The default access filter is the main guard against an unauthenticated
    // chat user reaching non-public material.
    const results = await searchVectors(fakeEmbed('internal staff only procedure document'), 20);
    expect(results.some((r) => r.payload.chunkId === 'chunk-i1')).toBe(false);
  });

  it('includes INTERNAL documents only when explicitly permitted', async ({ skip }) => {
    if (!available) return skip();

    const results = await searchVectors(
      fakeEmbed('internal staff only procedure document'),
      20,
      { accessLevels: ['PUBLIC', 'INTERNAL'] },
    );
    expect(results.some((r) => r.payload.chunkId === 'chunk-i1')).toBe(true);
  });

  it('applies the audience filter as a hard constraint', async ({ skip }) => {
    if (!available) return skip();

    const results = await searchVectors(fakeEmbed('training wage reimbursement'), 20, {
      audiences: ['employer', 'both'],
    });

    expect(results.some((r) => r.payload.chunkId === 'chunk-b1')).toBe(true);
    expect(results.some((r) => r.payload.chunkId === 'chunk-a1')).toBe(false);
  });

  it('treats county as a preference, not an exclusion', async ({ skip }) => {
    if (!available) return skip();

    // A Placer resident must still see agency-wide and other-county material,
    // otherwise a county mention would silently hide most of the corpus.
    const results = await searchVectors(fakeEmbed('training wage reimbursement'), 20, {
      counties: ['Placer'],
    });

    const ids = results.map((r) => r.payload.chunkId);
    expect(ids).toContain('chunk-a1');
    expect(ids).toContain('chunk-b1');
  });

  it('finds exact program names through keyword scroll', async ({ skip }) => {
    if (!available) return skip();

    const results = await scrollByKeywords(['wage reimbursement'], 10);
    expect(results.some((r) => r.payload.chunkId === 'chunk-b1')).toBe(true);
  });

  it('maps a chunk id to a stable UUID point id', async ({ skip }) => {
    if (!available) return skip();

    const first = pointIdForChunk('chunk-a1');
    expect(first).toBe(pointIdForChunk('chunk-a1'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(pointIdForChunk('chunk-a2'));
  });

  it('removes every vector for a document on delete', async ({ skip }) => {
    if (!available) return skip();

    const query = fakeEmbed('employer wage reimbursement on the job training');
    expect((await searchVectors(query, 20)).some((r) => r.payload.documentId === DOC_B)).toBe(true);

    await deleteByDocument(DOC_B);

    // Withdrawn content must not remain retrievable — this is the guarantee
    // that archiving a page actually takes it out of answers.
    expect((await searchVectors(query, 20)).some((r) => r.payload.documentId === DOC_B)).toBe(false);
  });
});
