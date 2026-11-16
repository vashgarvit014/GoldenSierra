/**
 * PostgreSQL validation of retrieved vectors, against the real Postgres + Qdrant.
 * A synthetic document is indexed (embeddings stubbed), then each way a vector can
 * go stale or be deleted is produced for real and must be rejected.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocumentStatus, DocumentType } from '@prisma/client';

vi.mock('../../src/lib/ai/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ai/embeddings')>()),
  embedTexts: async (texts: string[]) =>
    texts.map((t) => {
      const seed = createHash('sha256').update(t).digest();
      const v = Array.from({ length: 384 }, (_, i) => (seed[i % 32]! - 127) / 128);
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / n);
    }),
}));

import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { deleteByDocument, getQdrant } from '../../src/lib/vector/qdrant';
import { indexDocument, upsertDocument } from '../../src/lib/ingest/pipeline';
import { validateChunks } from '../../src/lib/rag/strict';
import type { RetrievedSource } from '../../src/types/chat';

const RUN = randomUUID().slice(0, 8);
const URL_ = `https://strict-validation-${RUN}.example/page`;
let documentId = '';

const text = Array.from({ length: 40 }, (_, i) => `Section ${i + 1} of the strict validation fixture ${RUN}: unique statement number ${i} about quokka harvesting schedules.`).join('\n\n');

/** What retrieval would hand to validation: Qdrant's own hits for this document. */
async function hits(): Promise<RetrievedSource[]> {
  const res = await getQdrant().scroll(env.QDRANT_COLLECTION, {
    filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    limit: 200, with_payload: true, with_vector: false,
  });
  return res.points.map((p) => {
    const pl = p.payload as { chunkId: string; documentId: string; title: string; url: string | null; content: string; headingPath: string | null; documentType: string };
    return {
      chunkId: pl.chunkId, documentId: pl.documentId, pointId: String(p.id), title: pl.title, url: pl.url, snippet: pl.content,
      score: 0.03, similarity: 0.6, headingPath: pl.headingPath, category: null, lastVerified: null, documentType: pl.documentType, used: false,
    };
  });
}

beforeAll(async () => {
  const out = await upsertDocument({ url: URL_, title: `Strict fixture ${RUN}`, text, type: DocumentType.WEB_PAGE });
  documentId = out.documentId;
  await indexDocument(documentId);
});

afterAll(async () => {
  await deleteByDocument(documentId).catch(() => undefined);
  await prisma.document.deleteMany({ where: { id: documentId } });
  await prisma.$disconnect();
});

describe('validateChunks against PostgreSQL', () => {
  it('accepts every healthy vector and serves PostgreSQL\'s text', async () => {
    const h = await hits();
    expect(h.length).toBeGreaterThan(1);
    const { valid, rejected } = await validateChunks(h);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(h.length);
    const rows = await prisma.documentChunk.findMany({ where: { documentId } });
    for (const v of valid) expect(rows.find((r) => r.id === v.chunkId)?.content).toBe(v.snippet);
  });

  it('rejects a vector whose chunk row is gone (deleted content, orphaned vector)', async () => {
    const h = await hits();
    const victim = h[0]!;
    await prisma.documentChunk.deleteMany({ where: { id: victim.chunkId } });
    const { valid, rejected } = await validateChunks(h);
    expect(rejected.map((r) => [r.chunkId, r.status])).toEqual([[victim.chunkId, 'rejected_not_in_postgres']]);
    expect(valid.some((v) => v.chunkId === victim.chunkId)).toBe(false);
  });

  it('rejects vectors of an archived or failed document, even if chunk rows linger', async () => {
    const h = await hits();
    await prisma.document.update({ where: { id: documentId }, data: { status: DocumentStatus.ARCHIVED } });
    const { valid, rejected } = await validateChunks(h);
    expect(valid).toEqual([]);
    expect(new Set(rejected.map((r) => r.status))).toEqual(new Set(['rejected_document_state', 'rejected_not_in_postgres']));
    await prisma.document.update({ where: { id: documentId }, data: { status: DocumentStatus.INDEXED } });
  });

  it('rejects non-public documents', async () => {
    const h = await hits();
    const present = h.filter((x) => true);
    await prisma.document.update({ where: { id: documentId }, data: { accessLevel: 'INTERNAL' } });
    const { valid, rejected } = await validateChunks(present);
    expect(valid).toEqual([]);
    expect(rejected.some((r) => r.status === 'rejected_not_public')).toBe(true);
    await prisma.document.update({ where: { id: documentId }, data: { accessLevel: 'PUBLIC' } });
  });

  it('rejects a vector whose text no longer matches the chunk (document re-indexed or edited since)', async () => {
    const h = await hits();
    const rows = await prisma.documentChunk.findMany({ where: { documentId }, take: 1 });
    const target = rows[0]!;
    await prisma.documentChunk.update({ where: { id: target.id }, data: { content: `${target.content} (revised text)` } });
    const { rejected } = await validateChunks(h);
    expect(rejected.find((r) => r.chunkId === target.id)?.status).toBe('rejected_stale_content');
    await prisma.documentChunk.update({ where: { id: target.id }, data: { content: target.content } });
  });

  it('rejects a vector whose point id is not the one PostgreSQL recorded', async () => {
    const h = await hits();
    const rows = await prisma.documentChunk.findMany({ where: { documentId }, take: 1 });
    const target = rows[0]!;
    const original = target.vectorId;
    await prisma.documentChunk.update({ where: { id: target.id }, data: { vectorId: '00000000-0000-5000-8000-000000000000' } });
    const { rejected } = await validateChunks(h);
    expect(rejected.find((r) => r.chunkId === target.id)?.status).toBe('rejected_stale_vector');
    await prisma.documentChunk.update({ where: { id: target.id }, data: { vectorId: original } });
  });

  it('rejects a vector that claims the wrong document', async () => {
    const h = await hits();
    const lie = { ...h[1]!, documentId: 'some-other-document' };
    const { rejected } = await validateChunks([lie]);
    expect(rejected[0]!.status).toBe('rejected_document_mismatch');
  });

  it('is healthy again once the document is restored', async () => {
    const { valid, rejected } = await validateChunks(await hits());
    // one chunk row was deleted by the first mutation; every other vector is valid again
    expect(rejected.map((r) => r.status)).toEqual(['rejected_not_in_postgres']);
    expect(valid.length).toBeGreaterThan(0);
  });
});
