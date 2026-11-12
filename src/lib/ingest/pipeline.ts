import { DocumentStatus, DocumentType, JobStatus, JobType, type Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { env } from '../env';
import { embedTexts } from '../ai/embeddings';
import {
  deleteByDocument,
  ensureCollection,
  pointIdForChunk,
  upsertPoints,
  type UpsertPoint,
  type VectorPayload,
} from '../vector/qdrant';
import { chunkDocument } from './chunk';
import {
  contentHash,
  detectAudience,
  detectCategory,
  detectCounties,
  detectLanguage,
  detectProgramName,
  detectTags,
  isLowValue,
  wordCount,
} from './clean';
import { crawl, normalizeUrl, type CrawlTarget } from './crawler';
import { fetchAndExtractPdf, extractPdfFromBuffer } from './pdf';
import type { ExtractedPage } from './extract';

/**
 * The ingestion pipeline:
 *
 *   discover -> extract -> clean -> classify -> persist -> chunk -> embed -> index
 *
 * Two properties matter most here:
 *
 *  1. *Incremental*. A document whose content hash is unchanged is skipped
 *     entirely — no re-embedding, no API spend. Only changed documents are
 *     re-chunked, and their old vectors are deleted before the new ones land.
 *
 *  2. *No orphans*. Vectors are only ever written for chunks that exist in
 *     Postgres, and archiving or deleting a document always removes its
 *     vectors first. Withdrawn content cannot survive in the index.
 */

export type JobLogEntry = { level: 'info' | 'warn' | 'error'; message: string; url?: string; at: string };

type JobCounters = {
  pagesDiscovered: number;
  pagesProcessed: number;
  documentsCreated: number;
  documentsUpdated: number;
  documentsSkipped: number;
  chunksIndexed: number;
  errorCount: number;
};

class JobTracker {
  private readonly entries: JobLogEntry[] = [];
  readonly counters: JobCounters = {
    pagesDiscovered: 0,
    pagesProcessed: 0,
    documentsCreated: 0,
    documentsUpdated: 0,
    documentsSkipped: 0,
    chunksIndexed: 0,
    errorCount: 0,
  };
  private lastFlush = 0;

  constructor(readonly jobId: string) {}

  log(level: JobLogEntry['level'], message: string, url?: string) {
    // Cap retained entries so a large crawl cannot bloat the row.
    if (this.entries.length < 500) {
      this.entries.push({ level, message, url, at: new Date().toISOString() });
    }
    if (level === 'error') this.counters.errorCount++;
  }

  async flush(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFlush < 2000) return;
    this.lastFlush = now;
    await prisma.ingestionJob.update({
      where: { id: this.jobId },
      data: { ...this.counters, log: this.entries as unknown as Prisma.InputJsonValue },
    }).catch((err) => logger.warn('Could not flush job progress', { jobId: this.jobId, err: String(err) }));
  }
}

// ──────────────────────────── Document upsert ────────────────────────────

export type DocumentInput = {
  url: string | null;
  canonicalUrl?: string | null;
  title: string;
  text: string;
  type: DocumentType;
  sourceId?: string | null;
  publishedAt?: Date | null;
  httpStatus?: number | null;
  /** Admin-supplied values that override the automatic classifiers. */
  overrides?: {
    category?: string | null;
    audience?: string | null;
    programName?: string | null;
    counties?: string[];
    tags?: string[];
    accessLevel?: 'PUBLIC' | 'INTERNAL';
  };
};

export type UpsertOutcome = {
  documentId: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  reason?: string;
};

export async function upsertDocument(input: DocumentInput): Promise<UpsertOutcome> {
  const text = input.text.trim();

  if (isLowValue(text)) {
    return { documentId: '', action: 'skipped', reason: 'too little content to index' };
  }

  const language = detectLanguage(input.url);
  const url = input.url ? normalizeUrl(input.url) : null;
  const hash = contentHash(input.title, text);

  const existing = url
    ? await prisma.document.findUnique({ where: { url_language: { url, language } } })
    : null;

  const classified = {
    category: input.overrides?.category ?? detectCategory(url, input.title, text),
    audience: input.overrides?.audience ?? detectAudience(url, input.title, text),
    programName: input.overrides?.programName ?? detectProgramName(input.title, text),
    counties: input.overrides?.counties ?? detectCounties(text),
    tags: input.overrides?.tags ?? detectTags(input.title, text),
    accessLevel: input.overrides?.accessLevel ?? ('PUBLIC' as const),
  };

  const common = {
    title: input.title,
    content: text,
    canonicalUrl: input.canonicalUrl ?? null,
    type: input.type,
    sourceId: input.sourceId ?? null,
    publishedAt: input.publishedAt ?? null,
    httpStatus: input.httpStatus ?? null,
    wordCount: wordCount(text),
    contentHash: hash,
    language,
    crawledAt: new Date(),
    lastVerifiedAt: new Date(),
    failureReason: null,
    ...classified,
  };

  if (existing) {
    if (existing.contentHash === hash && existing.status === DocumentStatus.INDEXED) {
      // Content is identical and already live: record that we re-checked it,
      // but spend nothing on re-embedding.
      await prisma.document.update({
        where: { id: existing.id },
        data: { lastVerifiedAt: new Date(), crawledAt: new Date() },
      });
      return { documentId: existing.id, action: 'unchanged' };
    }

    // Snapshot the superseded revision before overwriting it.
    await prisma.documentVersion.create({
      data: {
        documentId: existing.id,
        version: existing.version,
        title: existing.title,
        content: existing.content,
        contentHash: existing.contentHash,
      },
    }).catch(() => undefined); // a duplicate version row is not fatal

    const updated = await prisma.document.update({
      where: { id: existing.id },
      data: { ...common, version: existing.version + 1, status: DocumentStatus.EXTRACTED },
    });
    return { documentId: updated.id, action: 'updated' };
  }

  const created = await prisma.document.create({
    data: { ...common, url, status: DocumentStatus.EXTRACTED },
  });
  return { documentId: created.id, action: 'created' };
}

// ──────────────────────────── Indexing ────────────────────────────

/**
 * Chunks, embeds and indexes one document. Old vectors and chunk rows are
 * removed first so a re-index can never leave stale text retrievable.
 */
export async function indexDocument(documentId: string): Promise<{ chunks: number }> {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error(`Document ${documentId} not found`);

  if (document.status === DocumentStatus.ARCHIVED) {
    await deleteByDocument(documentId);
    await prisma.documentChunk.deleteMany({ where: { documentId } });
    return { chunks: 0 };
  }

  await ensureCollection();

  const chunks = await chunkDocument(document.content, { documentTitle: document.title });
  if (chunks.length === 0) {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.FAILED, failureReason: 'Chunking produced no content' },
    });
    return { chunks: 0 };
  }

  // Clear first: deleting vectors before writing new ones means a crash
  // mid-index leaves the document unsearchable rather than half-stale.
  await deleteByDocument(documentId);
  await prisma.documentChunk.deleteMany({ where: { documentId } });

  const created = await prisma.$transaction(
    chunks.map((chunk) =>
      prisma.documentChunk.create({
        data: {
          documentId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          headingPath: chunk.headingPath,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
        },
      }),
    ),
  );

  const vectors = await embedTexts(created.map((c) => c.content));

  const points: UpsertPoint[] = created.map((chunk, i) => {
    const vector = vectors[i];
    if (!vector) throw new Error(`Missing embedding for chunk ${chunk.id}`);
    const payload: VectorPayload = {
      chunkId: chunk.id,
      documentId: document.id,
      title: document.title,
      url: document.url,
      content: chunk.content,
      headingPath: chunk.headingPath,
      category: document.category,
      audience: document.audience,
      programName: document.programName,
      counties: document.counties,
      tags: document.tags,
      documentType: document.type,
      accessLevel: document.accessLevel,
      language: document.language,
      publishedAt: document.publishedAt?.toISOString() ?? null,
      lastVerifiedAt: document.lastVerifiedAt?.toISOString() ?? null,
      version: document.version,
      ordinal: chunk.ordinal,
    };
    return { id: pointIdForChunk(chunk.id), vector, payload };
  });

  await upsertPoints(points);

  const now = new Date();
  await prisma.$transaction([
    ...created.map((chunk) =>
      prisma.documentChunk.update({
        where: { id: chunk.id },
        data: {
          vectorId: pointIdForChunk(chunk.id),
          embeddedAt: now,
          embeddingModel: env.EMBEDDING_MODEL,
        },
      }),
    ),
    prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.INDEXED, failureReason: null },
    }),
  ]);

  return { chunks: created.length };
}

/** Archives a document and purges it from the vector index. */
export async function archiveDocument(documentId: string): Promise<void> {
  await deleteByDocument(documentId);
  await prisma.documentChunk.deleteMany({ where: { documentId } });
  await prisma.document.update({
    where: { id: documentId },
    data: { status: DocumentStatus.ARCHIVED },
  });
  logger.info('Archived document and purged its vectors', { documentId });
}

export async function deleteDocument(documentId: string): Promise<void> {
  await deleteByDocument(documentId);
  await prisma.document.delete({ where: { id: documentId } });
  logger.info('Deleted document and purged its vectors', { documentId });
}

// ──────────────────────────── Jobs ────────────────────────────

export async function createJob(
  type: JobType,
  sourceId?: string | null,
  params?: Record<string, unknown>,
): Promise<string> {
  const job = await prisma.ingestionJob.create({
    data: { type, sourceId: sourceId ?? null, params: (params ?? {}) as Prisma.InputJsonValue },
  });
  return job.id;
}

async function wasCancelled(jobId: string): Promise<boolean> {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId }, select: { status: true } });
  return job?.status === JobStatus.CANCELLED;
}

/** Runs a crawl job end to end: discovery, extraction, indexing, PDF follow-up. */
export async function runCrawlJob(jobId: string): Promise<void> {
  const job = await prisma.ingestionJob.findUnique({
    where: { id: jobId },
    include: { source: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  const source = job.source;
  if (!source?.rootUrl) throw new Error(`Job ${jobId} has no crawlable source`);

  const tracker = new JobTracker(jobId);
  const log = logger.child({ jobId, source: source.name });

  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: JobStatus.RUNNING, startedAt: new Date() },
  });

  const target: CrawlTarget = {
    rootUrl: source.rootUrl,
    maxDepth: source.maxDepth,
    maxPages: Math.min(source.maxPages, env.CRAWL_MAX_PAGES),
    respectRobots: source.respectRobots && env.CRAWL_RESPECT_ROBOTS,
    includePatterns: source.includePatterns,
    excludePatterns: source.excludePatterns,
  };

  const indexQueue: string[] = [];

  try {
    await ensureCollection();

    const summary = await crawl(target, {
      shouldStop: () => wasCancelled(jobId),
      onDiscovered: (count) => {
        tracker.counters.pagesDiscovered = count;
      },
      onPage: async (result) => {
        tracker.counters.pagesProcessed++;

        if (!result.ok) {
          tracker.log('error', result.reason, result.url);
          await tracker.flush();
          return;
        }

        try {
          const outcome = await upsertDocument({
            url: result.page.url,
            canonicalUrl: result.page.canonicalUrl,
            title: result.page.title,
            text: result.page.text,
            type: DocumentType.WEB_PAGE,
            sourceId: source.id,
            publishedAt: result.page.publishedAt,
            httpStatus: result.page.httpStatus,
            overrides: source.defaultCategory ? { category: source.defaultCategory } : undefined,
          });

          if (outcome.action === 'created') tracker.counters.documentsCreated++;
          else if (outcome.action === 'updated') tracker.counters.documentsUpdated++;
          else tracker.counters.documentsSkipped++;

          if (outcome.action === 'created' || outcome.action === 'updated') {
            indexQueue.push(outcome.documentId);
          }
        } catch (err) {
          tracker.log('error', err instanceof Error ? err.message : String(err), result.page.url);
        }

        await tracker.flush();
      },
    });

    tracker.log('info', `Crawl visited ${summary.visited} pages (${summary.failed} failed)`);

    // Index the changed pages after crawling, so embedding spend happens once
    // per document and network I/O is not interleaved with model calls.
    for (const documentId of indexQueue) {
      if (await wasCancelled(jobId)) break;
      try {
        const { chunks } = await indexDocument(documentId);
        tracker.counters.chunksIndexed += chunks;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tracker.log('error', `Indexing failed: ${message}`);
        await prisma.document.update({
          where: { id: documentId },
          data: { status: DocumentStatus.FAILED, failureReason: message.slice(0, 500) },
        }).catch(() => undefined);
      }
      await tracker.flush();
    }

    // Follow discovered PDFs. These are often where eligibility detail lives.
    for (const pdfUrl of summary.pdfLinks.slice(0, 50)) {
      if (await wasCancelled(jobId)) break;
      try {
        const outcome = await ingestPdfFromUrl(pdfUrl, source.id);
        if (outcome.action === 'created') tracker.counters.documentsCreated++;
        else if (outcome.action === 'updated') tracker.counters.documentsUpdated++;
        else tracker.counters.documentsSkipped++;
      } catch (err) {
        tracker.log('warn', `PDF skipped: ${err instanceof Error ? err.message : String(err)}`, pdfUrl);
      }
      await tracker.flush();
    }

    const cancelled = await wasCancelled(jobId);
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: cancelled ? JobStatus.CANCELLED : JobStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { lastCrawledAt: new Date() },
    });

    log.info('Crawl job finished', tracker.counters as unknown as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracker.log('error', message);
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: JobStatus.FAILED, error: message.slice(0, 2000), finishedAt: new Date() },
    });
    throw err;
  }
}

export async function ingestPdfFromUrl(url: string, sourceId?: string | null): Promise<UpsertOutcome> {
  const pdf = await fetchAndExtractPdf(url);
  const outcome = await upsertDocument({
    url,
    title: pdf.title,
    text: pdf.text,
    type: DocumentType.PDF,
    sourceId,
    publishedAt: pdf.publishedAt,
  });
  if (outcome.action === 'created' || outcome.action === 'updated') {
    await indexDocument(outcome.documentId);
  }
  return outcome;
}

export async function ingestPdfUpload(
  buffer: ArrayBuffer,
  filename: string,
  opts: { sourceId?: string | null; overrides?: DocumentInput['overrides']; url?: string | null } = {},
): Promise<UpsertOutcome & { chunks: number }> {
  const pdf = await extractPdfFromBuffer(buffer, { filename, url: opts.url ?? null });
  const outcome = await upsertDocument({
    // Uploads with no public URL get a stable internal identifier so the
    // unique (url, language) constraint still de-duplicates re-uploads.
    url: opts.url ?? `upload://${filename}`,
    title: pdf.title,
    text: pdf.text,
    type: DocumentType.PDF,
    sourceId: opts.sourceId ?? null,
    publishedAt: pdf.publishedAt,
    overrides: opts.overrides,
  });

  if (outcome.action === 'skipped') return { ...outcome, chunks: 0 };
  const { chunks } = await indexDocument(outcome.documentId);
  return { ...outcome, chunks };
}

/** Re-embeds every live document. Needed after an embedding-model change. */
export async function runReindexJob(jobId: string, documentIds?: string[]): Promise<void> {
  const tracker = new JobTracker(jobId);
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: JobStatus.RUNNING, startedAt: new Date() },
  });

  try {
    await ensureCollection();
    const documents = await prisma.document.findMany({
      where: documentIds?.length
        ? { id: { in: documentIds } }
        : { status: { in: [DocumentStatus.EXTRACTED, DocumentStatus.INDEXED, DocumentStatus.FAILED] } },
      select: { id: true, title: true },
    });

    tracker.counters.pagesDiscovered = documents.length;

    for (const document of documents) {
      if (await wasCancelled(jobId)) break;
      try {
        const { chunks } = await indexDocument(document.id);
        tracker.counters.chunksIndexed += chunks;
        tracker.counters.documentsUpdated++;
      } catch (err) {
        tracker.log('error', `${document.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
      tracker.counters.pagesProcessed++;
      await tracker.flush();
    }

    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: (await wasCancelled(jobId)) ? JobStatus.CANCELLED : JobStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: JobStatus.FAILED, error: message.slice(0, 2000), finishedAt: new Date() },
    });
    throw err;
  }
}

export async function runJob(jobId: string): Promise<void> {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  switch (job.type) {
    case JobType.CRAWL:
      return runCrawlJob(jobId);
    case JobType.REINDEX:
    case JobType.FULL_REBUILD: {
      const params = (job.params ?? {}) as { documentIds?: string[] };
      return runReindexJob(jobId, params.documentIds);
    }
    case JobType.PDF_INGEST: {
      const params = (job.params ?? {}) as { url?: string };
      if (!params.url) throw new Error('PDF_INGEST job requires a url parameter');
      await prisma.ingestionJob.update({
        where: { id: jobId },
        data: { status: JobStatus.RUNNING, startedAt: new Date() },
      });
      await ingestPdfFromUrl(params.url, job.sourceId);
      await prisma.ingestionJob.update({
        where: { id: jobId },
        data: { status: JobStatus.COMPLETED, finishedAt: new Date(), documentsCreated: 1 },
      });
      return;
    }
    case JobType.DELETE_DOCUMENT: {
      const params = (job.params ?? {}) as { documentId?: string };
      if (!params.documentId) throw new Error('DELETE_DOCUMENT job requires a documentId');
      await deleteDocument(params.documentId);
      await prisma.ingestionJob.update({
        where: { id: jobId },
        data: { status: JobStatus.COMPLETED, finishedAt: new Date() },
      });
      return;
    }
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

/**
 * Reconciles Postgres against Qdrant. Reports chunks that should be indexed
 * but are not, so a partial failure is visible rather than silently degrading
 * answer quality.
 */
export async function auditIndex(): Promise<{
  indexedDocuments: number;
  chunksInDb: number;
  chunksWithVectors: number;
  missingVectors: number;
}> {
  const [indexedDocuments, chunksInDb, chunksWithVectors] = await Promise.all([
    prisma.document.count({ where: { status: DocumentStatus.INDEXED } }),
    prisma.documentChunk.count(),
    prisma.documentChunk.count({ where: { vectorId: { not: null } } }),
  ]);
  return {
    indexedDocuments,
    chunksInDb,
    chunksWithVectors,
    missingVectors: chunksInDb - chunksWithVectors,
  };
}
