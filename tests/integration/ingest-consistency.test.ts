/**
 * Ingestion consistency, against the real Postgres + Qdrant.
 *
 * Only synthetic documents are used (a generated PDF, a loopback HTTP server,
 * a reserved `.invalid` host). Everything the suite creates is tracked by id
 * and removed in afterAll; existing knowledge is never read-modified. The
 * embedding model is replaced with a deterministic stub so no model loads.
 */
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentStatus, DocumentType, JobStatus, JobType } from '@prisma/client';
import { syntheticLines, syntheticPdf } from '../helpers/synthetic-pdf';

const embedMock = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock('../../src/lib/ai/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ai/embeddings')>()),
  embedTexts: async (texts: string[]) => {
    if (embedMock.fail) {
      const err = embedMock.fail;
      embedMock.fail = null;
      throw err;
    }
    return texts.map((t) => {
      const seed = createHash('sha256').update(t).digest();
      const v = Array.from({ length: 384 }, (_, i) => (seed[i % 32]! - 127) / 128);
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
}));

const qdrantHooks = vi.hoisted(() => ({
  failUpsert: null as Error | null,
  failStaleDelete: null as Error | null,
}));
vi.mock('../../src/lib/vector/qdrant', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/vector/qdrant')>();
  return {
    ...real,
    upsertPoints: async (...args: Parameters<typeof real.upsertPoints>) => {
      if (qdrantHooks.failUpsert) {
        const err = qdrantHooks.failUpsert;
        qdrantHooks.failUpsert = null;
        // Simulate a partial batch: some points land, then the call fails.
        await real.upsertPoints(args[0].slice(0, 1));
        throw err;
      }
      return real.upsertPoints(...args);
    },
    deleteStaleVectors: async (...args: Parameters<typeof real.deleteStaleVectors>) => {
      if (qdrantHooks.failStaleDelete) {
        const err = qdrantHooks.failStaleDelete;
        qdrantHooks.failStaleDelete = null;
        throw err;
      }
      return real.deleteStaleVectors(...args);
    },
  };
});

import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant, deleteByDocument } from '../../src/lib/vector/qdrant';
import {
  auditIndex,
  createJob,
  failInterruptedUploads,
  indexDocument,
  ingestPdfUploadTracked,
  runJob,
  upsertDocument,
} from '../../src/lib/ingest/pipeline';
import { JobInFlightError, STALE_RUN_MS } from '../../src/lib/ingest/safety';

// ───────────────────────── fixtures ─────────────────────────

const RUN = randomUUID().slice(0, 8);
const jobIds = new Set<string>();
const documentUrls = new Set<string>();

let server: http.Server;
let base = '';
const hits = new Map<string, number>();
let pdfVersion = 'v1';
let failNextRequests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path.startsWith('/flaky') && failNextRequests > 0) {
      failNextRequests--;
      res.writeHead(503).end('unavailable');
      return;
    }
    if (path.startsWith('/missing')) {
      res.writeHead(404).end('nope');
      return;
    }
    const body = Buffer.from(syntheticPdf(syntheticLines(`${RUN}-${pdfVersion}`), `Synthetic ${RUN}`));
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const docs = await prisma.document.findMany({
    where: { OR: [...documentUrls].map((url) => ({ url })) },
    select: { id: true },
  });
  for (const { id } of docs) await deleteByDocument(id).catch(() => undefined);
  await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }); // chunks cascade
  await prisma.ingestionJob.deleteMany({ where: { id: { in: [...jobIds] } } });
  // Upload jobs created by a call that threw never reached jobIds; match them
  // by the unique synthetic filename instead.
  for (const prefix of ['upload', 'broken']) {
    await prisma.ingestionJob.deleteMany({
      where: { params: { path: ['filename'], string_starts_with: `${prefix}-${RUN}` } },
    });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  hits.clear();
  failNextRequests = 0;
  pdfVersion = 'v1';
  embedMock.fail = null;
  qdrantHooks.failUpsert = null;
  qdrantHooks.failStaleDelete = null;
});

async function newJob(url: string): Promise<string> {
  const id = await createJob(JobType.PDF_INGEST, null, { url });
  jobIds.add(id);
  return id;
}

async function vectorsFor(documentId: string): Promise<{ ids: string[]; chunkIds: string[] }> {
  const res = await getQdrant().scroll(env.QDRANT_COLLECTION, {
    filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    limit: 1000,
    with_payload: ['chunkId'],
    with_vector: false,
  });
  return {
    ids: res.points.map((p) => String(p.id)),
    chunkIds: res.points.map((p) => String((p.payload as { chunkId: string }).chunkId)),
  };
}

async function chunkRows(documentId: string) {
  return prisma.documentChunk.findMany({ where: { documentId }, orderBy: { ordinal: 'asc' } });
}

/** Postgres and Qdrant agree about one document, chunk for chunk. */
async function expectConsistent(documentId: string) {
  const rows = await chunkRows(documentId);
  const vectors = await vectorsFor(documentId);
  expect(rows.length).toBeGreaterThan(0);
  expect(vectors.ids.sort()).toEqual(rows.map((r) => r.vectorId!).sort());
  expect(vectors.chunkIds.sort()).toEqual(rows.map((r) => r.id).sort());
}

async function synthetic(text: string, url = `https://synthetic-${RUN}.invalid/${randomUUID()}.pdf`) {
  documentUrls.add(url);
  const outcome = await upsertDocument({
    url,
    title: `Synthetic ${RUN}`,
    text,
    type: DocumentType.PDF,
  });
  return { url, documentId: outcome.documentId };
}

const longText = (tag: string) => syntheticLines(tag, 40).join('\n\n');

// ───────────────────────── 1. input validation ─────────────────────────

describe('PDF_INGEST input validation', () => {
  it.each(['upload://report.pdf', 'ftp://host/a.pdf', 'file:///etc/hosts', 'javascript:alert(1)', 'nonsense'])(
    'refuses to create a job for %s',
    async (url) => {
      const before = await prisma.ingestionJob.count();
      await expect(createJob(JobType.PDF_INGEST, null, { url })).rejects.toThrow(/http|valid|required|upload/i);
      expect(await prisma.ingestionJob.count()).toBe(before);
    },
  );

  it('refuses a job with no url', async () => {
    await expect(createJob(JobType.PDF_INGEST, null, {})).rejects.toThrow(/required/i);
  });
});

// ───────────────────────── 2. failures, retries, duplicates ─────────────────────────

describe('job lifecycle', () => {
  it('indexes a PDF end to end and Postgres matches Qdrant', async () => {
    const url = `${base}/ok-${RUN}.pdf`;
    documentUrls.add(url);
    const jobId = await newJob(url);
    await runJob(jobId);

    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.documentsCreated).toBe(1);
    const doc = await prisma.document.findFirstOrThrow({ where: { url } });
    expect(doc.status).toBe(DocumentStatus.INDEXED);
    await expectConsistent(doc.id);
  });

  it('records the full cause (code + message) of a failure, with no credentials', async () => {
    // .invalid is reserved (RFC 2606) and can never resolve.
    const jobId = await newJob(`https://pdf-test-${RUN}.invalid/x.pdf`);
    await expect(runJob(jobId)).rejects.toThrow();

    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe(JobStatus.FAILED);
    expect(job.error).toMatch(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/); // the cause, not just a wrapper message
    expect(job.error).not.toMatch(/password|api[_-]?key|Bearer/i);
    expect(job.finishedAt).not.toBeNull();
  });

  it('records an HTTP failure and leaves no document behind', async () => {
    const url = `${base}/missing-${RUN}.pdf`;
    const docsBefore = await prisma.document.count({ where: { url } });
    const jobId = await newJob(url);
    await expect(runJob(jobId)).rejects.toThrow(/404/);
    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe(JobStatus.FAILED);
    expect(job.error).toMatch(/HTTP 404/);
    expect(await prisma.document.count({ where: { url } })).toBe(docsBefore);
  });

  it('retries a FAILED job to completion (a BullMQ retry attempt)', async () => {
    const url = `${base}/flaky-${RUN}.pdf`;
    documentUrls.add(url);
    const jobId = await newJob(url);

    failNextRequests = 1;
    await expect(runJob(jobId)).rejects.toThrow(/503/); // attempt 1
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(JobStatus.FAILED);

    await runJob(jobId); // attempt 2: the claim must succeed on a FAILED row
    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.error).toBeNull(); // the earlier failure text is cleared
    const doc = await prisma.document.findFirstOrThrow({ where: { url } });
    await expectConsistent(doc.id);
  });

  it('processes a duplicate delivery exactly once', async () => {
    const url = `${base}/dup-${RUN}.pdf`;
    documentUrls.add(url);
    const jobId = await newJob(url);

    const results = await Promise.allSettled([runJob(jobId), runJob(jobId), runJob(jobId)]);

    // Exactly one delivery did the work; the others deferred or acknowledged.
    expect(hits.get(`/dup-${RUN}.pdf`)).toBe(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(JobInFlightError);
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    // A late duplicate after completion is acknowledged, not re-run.
    await runJob(jobId);
    expect(hits.get(`/dup-${RUN}.pdf`)).toBe(1);

    const doc = await prisma.document.findFirstOrThrow({ where: { url } });
    expect((await chunkRows(doc.id)).length).toBeGreaterThan(0);
    await expectConsistent(doc.id);
  });

  it('does not report success for a job a live run still owns', async () => {
    const url = `${base}/owned-${RUN}.pdf`;
    const jobId = await newJob(url);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: JobStatus.RUNNING, startedAt: new Date() },
    });

    await expect(runJob(jobId)).rejects.toBeInstanceOf(JobInFlightError); // not a silent return
    expect(hits.size).toBe(0);
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(JobStatus.RUNNING);
  });

  it('recovers a job whose worker crashed (stale RUNNING)', async () => {
    const url = `${base}/crashed-${RUN}.pdf`;
    documentUrls.add(url);
    const jobId = await newJob(url);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: JobStatus.RUNNING, startedAt: new Date(Date.now() - STALE_RUN_MS - 60_000) },
    });

    await runJob(jobId);
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(JobStatus.COMPLETED);
    expect(hits.get(`/crashed-${RUN}.pdf`)).toBe(1);
  });

  it('acknowledges a cancelled job without running it', async () => {
    const jobId = await newJob(`${base}/cancelled-${RUN}.pdf`);
    await prisma.ingestionJob.update({ where: { id: jobId }, data: { status: JobStatus.CANCELLED } });
    await runJob(jobId);
    expect(hits.size).toBe(0);
  });
});

// ───────────────────────── 3. crash-safe re-indexing ─────────────────────────

describe('re-index is crash-safe', () => {
  async function indexedDoc() {
    const { documentId } = await synthetic(longText(`${RUN}-A`));
    await indexDocument(documentId);
    await expectConsistent(documentId);
    return documentId;
  }

  async function changeContent(documentId: string, tag: string) {
    await prisma.document.update({
      where: { id: documentId },
      data: { content: longText(tag), status: DocumentStatus.EXTRACTED },
    });
  }

  it('keeps the old content searchable when embedding fails', async () => {
    const documentId = await indexedDoc();
    const before = await chunkRows(documentId);
    await changeContent(documentId, `${RUN}-B`);

    embedMock.fail = new Error('embedding service unavailable');
    await expect(indexDocument(documentId)).rejects.toThrow(/embedding service/);

    expect((await chunkRows(documentId)).map((c) => c.id)).toEqual(before.map((c) => c.id));
    await expectConsistent(documentId);
  });

  it('keeps the old content searchable when the vector upsert partially fails', async () => {
    const documentId = await indexedDoc();
    const before = await chunkRows(documentId);
    await changeContent(documentId, `${RUN}-B`);

    qdrantHooks.failUpsert = new Error('qdrant write timeout');
    await expect(indexDocument(documentId)).rejects.toThrow(/qdrant write timeout/);

    // The point that did land was removed again; only the old set remains.
    expect((await chunkRows(documentId)).map((c) => c.id)).toEqual(before.map((c) => c.id));
    await expectConsistent(documentId);
  });

  it('keeps the old content live when the Postgres swap fails after vectors were written', async () => {
    const documentId = await indexedDoc();
    const before = await chunkRows(documentId);
    await changeContent(documentId, `${RUN}-B`);

    // One-shot fault on the instance, removed again so later calls use the
    // real prototype method.
    const client = prisma as unknown as Record<string, unknown>;
    client.$transaction = async () => {
      delete client.$transaction;
      throw new Error('connection reset');
    };
    await expect(indexDocument(documentId)).rejects.toThrow(/connection reset/);
    delete client.$transaction;

    expect((await chunkRows(documentId)).map((c) => c.id)).toEqual(before.map((c) => c.id));
    await expectConsistent(documentId); // the unreferenced new points were cleaned up
  });

  it('swaps cleanly on success: new chunks live, old ones gone from both stores', async () => {
    const documentId = await indexedDoc();
    const before = await chunkRows(documentId);
    await changeContent(documentId, `${RUN}-B`);

    await indexDocument(documentId);

    const after = await chunkRows(documentId);
    expect(after.some((c) => before.some((b) => b.id === c.id))).toBe(false);
    expect(after[0]!.content).toContain(`${RUN}-B`);
    await expectConsistent(documentId);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe(DocumentStatus.INDEXED);
  });

  it('survives a crash after the swap (stale vectors) and self-heals on the next run', async () => {
    const documentId = await indexedDoc();
    await changeContent(documentId, `${RUN}-B`);

    qdrantHooks.failStaleDelete = new Error('crash before cleanup');
    await indexDocument(documentId); // does not throw: the new content is already correct

    // Postgres is right; Qdrant still holds the old points as well.
    const rows = await chunkRows(documentId);
    const vectors = await vectorsFor(documentId);
    expect(rows[0]!.content).toContain(`${RUN}-B`);
    expect(vectors.ids.length).toBeGreaterThan(rows.length);

    // The audit sees the surplus…
    const audit = await auditIndex();
    expect(audit.orphanVectors).toBeGreaterThan(0);

    // …and the next index run removes it.
    await prisma.document.update({ where: { id: documentId }, data: { status: DocumentStatus.EXTRACTED } });
    await indexDocument(documentId);
    await expectConsistent(documentId);
  });

  it('never leaves a document unsearchable at any failure point', async () => {
    const documentId = await indexedDoc();
    for (const fault of ['embed', 'upsert'] as const) {
      await changeContent(documentId, `${RUN}-${fault}`);
      if (fault === 'embed') embedMock.fail = new Error('x');
      else qdrantHooks.failUpsert = new Error('x');
      await indexDocument(documentId).catch(() => undefined);
      expect((await vectorsFor(documentId)).ids.length).toBeGreaterThan(0);
      expect((await chunkRows(documentId)).length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────── 4. uploads tracked as jobs ─────────────────────────

describe('uploaded PDFs are tracked as jobs', () => {
  it('records a completed upload job and indexes the file exactly once', async () => {
    const name = `upload-${RUN}.pdf`;
    documentUrls.add(`upload://${name}`);
    const buffer = syntheticPdf(syntheticLines(`${RUN}-up`));

    const first = await ingestPdfUploadTracked(buffer.slice(0), name); // pdf.js detaches what it parses
    jobIds.add(first.jobId);

    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(job.type).toBe(JobType.PDF_INGEST);
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.documentsCreated).toBe(1);
    expect(job.chunksIndexed).toBe(first.chunks);
    expect((job.params as { upload?: boolean }).upload).toBe(true);
    await expectConsistent(first.documentId);

    // Re-uploading identical bytes must not duplicate chunks or vectors.
    const chunksBefore = (await chunkRows(first.documentId)).length;
    const second = await ingestPdfUploadTracked(buffer.slice(0), name);
    jobIds.add(second.jobId);
    expect(second.documentId).toBe(first.documentId);
    expect(second.action).toBe('unchanged');
    const job2 = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: second.jobId } });
    expect(job2.documentsSkipped).toBe(1);
    expect((await chunkRows(first.documentId)).length).toBe(chunksBefore);
    await expectConsistent(first.documentId);
  });

  it('records a failed upload with the reason, and creates no document', async () => {
    const name = `broken-${RUN}.pdf`;
    const docsBefore = await prisma.document.count();
    const jobsBefore = new Set((await prisma.ingestionJob.findMany({ select: { id: true } })).map((j) => j.id));

    await expect(
      ingestPdfUploadTracked(new TextEncoder().encode('this is not a pdf').buffer as ArrayBuffer, name),
    ).rejects.toThrow(/not a valid PDF/);

    const created = (await prisma.ingestionJob.findMany()).filter((j) => !jobsBefore.has(j.id));
    expect(created).toHaveLength(1);
    jobIds.add(created[0]!.id);
    expect(created[0]!.status).toBe(JobStatus.FAILED);
    expect(created[0]!.error).toMatch(/not a valid PDF/);
    expect(await prisma.document.count()).toBe(docsBefore);
  });

  it('closes an upload job whose request died mid-flight, and only that', async () => {
    const mk = (params: object, startedAgoMs: number, type: JobType = JobType.PDF_INGEST) =>
      prisma.ingestionJob
        .create({
          data: { type, status: JobStatus.RUNNING, startedAt: new Date(Date.now() - startedAgoMs), params },
        })
        .then((j) => (jobIds.add(j.id), j.id));

    const crashed = await mk({ upload: true, filename: `upload-${RUN}-crashed.pdf` }, STALE_RUN_MS + 60_000);
    const inProgress = await mk({ upload: true, filename: `upload-${RUN}-live.pdf` }, 5_000);
    const urlJob = await mk({ url: `${base}/x.pdf` }, STALE_RUN_MS + 60_000); // retryable, not an upload

    const swept = await failInterruptedUploads();
    expect(swept).toBeGreaterThanOrEqual(1);

    const row = (id: string) => prisma.ingestionJob.findUniqueOrThrow({ where: { id } });
    const a = await row(crashed);
    expect(a.status).toBe(JobStatus.FAILED);
    expect(a.error).toMatch(/interrupted/i);
    expect(a.finishedAt).not.toBeNull();
    expect((await row(inProgress)).status).toBe(JobStatus.RUNNING); // a live upload is untouched
    expect((await row(urlJob)).status).toBe(JobStatus.RUNNING); // URL jobs are reclaimed by runJob, not swept

    expect(await failInterruptedUploads()).toBe(0); // idempotent
  });

  it('never leaves an upload job RUNNING or QUEUED', async () => {
    const stuck = await prisma.ingestionJob.count({
      where: {
        id: { in: [...jobIds] },
        status: { in: [JobStatus.RUNNING, JobStatus.QUEUED] },
        params: { path: ['upload'], equals: true },
        startedAt: { lt: new Date(Date.now() - 60_000) },
      },
    });
    expect(stuck).toBe(0);
  });
});
