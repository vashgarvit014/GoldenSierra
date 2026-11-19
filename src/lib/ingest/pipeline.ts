import { extractJobListings } from '../jobs/extract';
import { randomUUID } from 'node:crypto';
import { DocumentStatus, DocumentType, JobStatus, JobType, type Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { env, hasLlm } from '../env';
import { embedTexts } from '../ai/embeddings';
import {
  deleteByDocument,
  deleteByChunkIds,
  deleteStaleVectors,
  collectionStats,
  ensureCollection,
  pointIdForChunk,
  setSourceIdPayload,
  upsertPoints,
  type UpsertPoint,
  type VectorPayload,
} from '../vector/qdrant';
import { chunkDocument } from './chunk';
import {
  contentHash,
  detectAudience,
  detectCategory,
  isInformative,
  detectCounties,
  detectLanguage,
  detectProgramName,
  detectTags,
  isLowValue,
  wordCount,
} from './clean';
import { crawl, normalizeUrl, scopeHostOf, urlInScope, type CrawlTarget } from './crawler';
import { fetchAndExtractPdf, extractPdfFromBuffer } from './pdf';
import type { ExtractedPage } from './extract';
import {
  bumpStage,
  initialProgress,
  patchStage,
  settleStages,
  type JobProgress,
  type StageId,
} from './progress';
import {
  STALE_RUN_MS,
  JobInFlightError,
  decideClaim,
  describeError,
  validatePdfUrl,
} from './safety';

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
  readonly progress: JobProgress = initialProgress();
  private lastFlush = 0;

  constructor(readonly jobId: string) {}

  /** Moves a stage between states; transitions are written out immediately. */
  async stage(id: StageId, patch: Parameters<typeof patchStage>[2]) {
    patchStage(this.progress, id, patch);
    await this.flush(true);
  }

  /** Hooks for `indexDocument`: each call is one real unit of work finishing. */
  indexHooks(): IndexHooks {
    return {
      onChunked: (n) => bumpStage(this.progress, 'chunk', { done: 1, count: n }),
      onEmbedded: (n) => bumpStage(this.progress, 'embed', { done: 1, count: n }),
      onIndexed: (n) => bumpStage(this.progress, 'index', { done: 1, count: n }),
    };
  }

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
      data: {
        ...this.counters,
        log: this.entries as unknown as Prisma.InputJsonValue,
        progress: this.progress as unknown as Prisma.InputJsonValue,
      },
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
 * Chunks, embeds and indexes one document — crash-safe.
 *
 * The live index is only touched once everything that replaces it exists:
 *
 *   1. chunk, then embed        (nothing mutated; a failure here changes nothing)
 *   2. upsert the NEW points    (fresh ids, so the old ones keep serving)
 *   3. one Postgres transaction (drop old chunk rows, insert new, mark INDEXED)
 *   4. delete every other vector of this document
 *
 * A crash before 3 leaves the old chunks and vectors fully intact (plus some
 * unreferenced new points, removed best-effort below and by step 4 of the next
 * run). A crash between 3 and 4 leaves the new content live and some stale
 * points that the next run — or `auditIndex` — reveals and step 4 removes.
 * At no point is the document unsearchable.
 */
export type IndexHooks = {
  onChunked?: (chunks: number) => void;
  onEmbedded?: (vectors: number) => void;
  onIndexed?: (vectors: number) => void;
};

export async function indexDocument(
  documentId: string,
  hooks: IndexHooks = {},
): Promise<{ chunks: number }> {
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
    // Existing chunks and vectors are left alone: a failed re-chunk must not
    // take down what is already searchable.
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.FAILED, failureReason: 'Chunking produced no content' },
    });
    return { chunks: 0 };
  }

  hooks.onChunked?.(chunks.length);

  // 1. Embed everything before changing anything.
  const vectors = await embedTexts(chunks.map((c) => c.content));
  hooks.onEmbedded?.(vectors.length);
  const rows = chunks.map((chunk, i) => {
    const vector = vectors[i];
    if (!vector) throw new Error(`Missing embedding for chunk ${chunk.ordinal} of ${documentId}`);
    return { chunk, vector, id: randomUUID() };
  });

  const points: UpsertPoint[] = rows.map(({ chunk, vector, id }) => {
    const payload: VectorPayload = {
      chunkId: id,
      documentId: document.id,
      sourceId: document.sourceId,
      title: document.title,
      url: document.url,
      content: chunk.content,
      headingPath: chunk.headingPath,
      category: document.category,
      // Recomputed per chunk so a section is ranked on what it actually says,
      // not on whatever the page as a whole was labelled.
      chunkCategory: detectCategory(
        document.url,
        chunk.headingPath ?? document.title,
        chunk.content,
      ),
      informative: isInformative(chunk.content),
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
    return { id: pointIdForChunk(id), vector, payload };
  });
  const newChunkIds = rows.map((r) => r.id);

  // 2. Add the replacement points alongside the old ones.
  try {
    await upsertPoints(points);
  } catch (err) {
    await deleteByChunkIds(newChunkIds).catch(() => undefined); // partial batch
    throw err;
  }

  // 3. Swap the Postgres side atomically.
  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.documentChunk.deleteMany({ where: { documentId } }),
      prisma.documentChunk.createMany({
        data: rows.map(({ chunk, id }) => ({
          id,
          documentId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          headingPath: chunk.headingPath,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          vectorId: pointIdForChunk(id),
          embeddedAt: now,
          embeddingModel: env.EMBEDDING_MODEL,
        })),
      }),
      prisma.document.update({
        where: { id: documentId },
        data: { status: DocumentStatus.INDEXED, failureReason: null },
      }),
    ]);
  } catch (err) {
    // The old chunk rows survived (the transaction rolled back), so the old
    // vectors are still the live ones. Drop the unreferenced new points.
    await deleteByChunkIds(newChunkIds).catch((cleanupErr) =>
      logger.warn('Could not remove unreferenced vectors after a failed swap', {
        documentId,
        error: describeError(cleanupErr),
      }),
    );
    throw err;
  }

  hooks.onIndexed?.(rows.length);

  // 4. The new content is live; retire everything else this document has in
  //    the index. If this fails the document is still correct — only stale
  //    duplicates remain — so it is reported, not thrown.
  try {
    await deleteStaleVectors(documentId, newChunkIds);
  } catch (err) {
    logger.warn('Stale vectors remain after a successful swap; the next re-index will clear them', {
      documentId,
      error: describeError(err),
    });
  }

  return { chunks: rows.length };
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

/**
 * Takes every document of a source out of search: vectors and chunks are
 * removed and the rows are kept as ARCHIVED, so the source's history survives
 * but nothing it contained can be retrieved.
 */
export async function archiveSourceDocuments(sourceId: string): Promise<number> {
  const docs = await prisma.document.findMany({
    where: { sourceId, status: { not: DocumentStatus.ARCHIVED } },
    select: { id: true },
  });
  for (const doc of docs) await archiveDocument(doc.id);
  return docs.length;
}

/** Tags vectors written before `sourceId` existed in the payload. Safe to re-run. */
export async function backfillSourceIds(): Promise<{ sources: number; documents: number }> {
  const sources = await prisma.knowledgeSource.findMany({ select: { id: true } });
  let documents = 0;
  for (const source of sources) {
    const docs = await prisma.document.findMany({
      where: { sourceId: source.id, status: DocumentStatus.INDEXED },
      select: { id: true },
    });
    await setSourceIdPayload(source.id, docs.map((d) => d.id));
    documents += docs.length;
  }
  return { sources: sources.length, documents };
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
  // Reject at the door: a job that can never succeed only wastes a retry cycle
  // and leaves a FAILED row behind.
  if (type === JobType.PDF_INGEST) {
    params = { ...params, url: validatePdfUrl(params?.url) };
  }
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
  // Honest accounting of what actually became searchable, independent of how
  // many pages were merely visited.
  const tally = { unchanged: 0, lowValue: 0, duplicates: 0, jsLimited: 0, indexFailures: 0, pdfFailures: 0, pdfOk: 0 };

  try {
    await ensureCollection();
    await tracker.stage('discover', { state: 'running' });

    const summary = await crawl(target, {
      shouldStop: () => wasCancelled(jobId),
      onDiscovered: (count) => {
        tracker.counters.pagesDiscovered = count;
        patchStage(tracker.progress, 'discover', { done: count, total: count });
        patchStage(tracker.progress, 'extract', { total: count, state: 'running' });
      },
      onPage: async (result) => {
        tracker.counters.pagesProcessed++;
        bumpStage(tracker.progress, 'extract', {
          done: 1,
          errors: result.ok ? 0 : 1,
        });

        if (!result.ok) {
          tracker.log('error', result.reason, result.url);
          await tracker.flush();
          return;
        }

        if (result.duplicateOf) {
          tally.duplicates++;
          tracker.counters.documentsSkipped++;
          tracker.log('info', `Duplicate of ${result.duplicateOf}; not indexed twice`, result.page.url);
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

          if (outcome.action === 'unchanged') tally.unchanged++;
          if (outcome.action === 'skipped') {
            tally.lowValue++;
            if (result.page.jsRequired) {
              tally.jsLimited++;
              tracker.log('warn', 'Page appears to need JavaScript to render; only its static HTML was available, so nothing was indexed. Client-rendered sites are not supported.', result.page.url);
            } else {
              tracker.log('warn', `Skipped: ${outcome.reason ?? 'too little content'}`, result.page.url);
            }
          }
          if (outcome.action === 'created' || outcome.action === 'updated') {
            indexQueue.push(outcome.documentId);
          }
        } catch (err) {
          tracker.log('error', describeError(err, 500), result.page.url);
        }

        await tracker.flush();
      },
    });

    tracker.log('info', `Crawl visited ${summary.visited} pages (${summary.failed} failed)`);
    if (summary.sitemapUrls) tracker.log('info', `Sitemap listed ${summary.sitemapUrls} in-scope URLs`);
    if (summary.skippedOffScope) tracker.log('info', `Ignored ${summary.skippedOffScope} links to other domains (outside this source's scope)`);
    if (summary.skippedByRobots) tracker.log('warn', `${summary.skippedByRobots} URL(s) were skipped because robots.txt disallows them`);
    if (summary.budgetExhausted && summary.budgetExhausted !== 'pages') {
      tracker.log('warn', `Crawl stopped early: the ${summary.budgetExhausted === 'bytes' ? 'download-size' : 'time'} budget was used up`);
    }

    // Discovery and extraction are over; what remains is turning changed
    // documents into searchable vectors.
    patchStage(tracker.progress, 'discover', { state: 'completed' });
    patchStage(tracker.progress, 'extract', {
      state: tracker.progress.stages.extract.errors >= tracker.counters.pagesProcessed && tracker.counters.pagesProcessed > 0 ? 'failed' : 'completed',
    });
    for (const id of ['chunk', 'embed', 'index'] as const) {
      patchStage(tracker.progress, id, { total: indexQueue.length, state: indexQueue.length ? 'running' : 'pending' });
    }
    await tracker.flush(true);

    // Index the changed pages after crawling, so embedding spend happens once
    // per document and network I/O is not interleaved with model calls.
    for (const documentId of indexQueue) {
      if (await wasCancelled(jobId)) break;
      try {
        const { chunks } = await indexDocument(documentId, tracker.indexHooks());
        tracker.counters.chunksIndexed += chunks;
      } catch (err) {
        const message = describeError(err, 500);
        tracker.log('error', `Indexing failed: ${message}`);
        tally.indexFailures++;
        for (const id of ['chunk', 'embed', 'index'] as const) bumpStage(tracker.progress, id, { errors: 1 });
        await prisma.document.update({
          where: { id: documentId },
          data: { status: DocumentStatus.FAILED, failureReason: message },
        }).catch(() => undefined);
      }
      await tracker.flush();
    }

    // Follow discovered PDFs. These are often where eligibility detail lives.
    for (const pdfUrl of summary.pdfLinks.slice(0, 50)) {
      if (await wasCancelled(jobId)) break;
      try {
        const outcome = await ingestPdfFromUrl(pdfUrl, source.id, tracker.indexHooks(), (u) => urlInScope(u, scopeHostOf(source.rootUrl!)));
        if (outcome.action === 'created') tracker.counters.documentsCreated++;
        else if (outcome.action === 'updated') tracker.counters.documentsUpdated++;
        else tracker.counters.documentsSkipped++;
        if (outcome.action !== 'skipped') tally.pdfOk++;
      } catch (err) {
        tally.pdfFailures++;
        tracker.counters.errorCount++;
        tracker.log('warn', `PDF skipped: ${describeError(err, 500)}`, pdfUrl);
      }
      await tracker.flush();
    }

    // Job boards and listing tables in this source become structured job listings (every field verbatim
    // from the page), so job matching sees postings from every crawled site, not only uploaded tables.
    if (!(await wasCancelled(jobId)) && hasLlm()) {
      try {
        const docs = await prisma.document.findMany({ where: { sourceId: source.id, status: DocumentStatus.INDEXED }, select: { id: true } });
        const reports = await extractJobListings({ documentIds: docs.map((d) => d.id) });
        const postings = reports.reduce((n, r) => n + r.listings, 0);
        if (reports.length) tracker.log('info', `Job postings extracted: ${postings} from ${reports.length} job page${reports.length === 1 ? '' : 's'}.`);
      } catch (err) {
        tracker.log('warn', `Job posting extraction skipped: ${describeError(err, 300)}`);
      }
      await tracker.flush();
    }

    const cancelled = await wasCancelled(jobId);
    const indexedNow = indexQueue.length - tally.indexFailures;
    const searchable = indexedNow + tally.unchanged + tally.pdfOk;
    const failures = summary.failed + tally.indexFailures + tally.pdfFailures;
    const stoppedByBudget = summary.budgetExhausted === 'bytes' || summary.budgetExhausted === 'time';

    let status: JobStatus = JobStatus.COMPLETED;
    let note: string | null = null;
    if (cancelled) {
      status = JobStatus.CANCELLED;
    } else if (summary.robotsBlocked) {
      status = JobStatus.FAILED;
      note = "robots.txt disallows crawling this site, so nothing was fetched. The crawler honours robots.txt and cannot override it.";
    } else if (searchable === 0 && summary.accessBlocked) {
      status = JobStatus.FAILED;
      note = `This site blocks automated access: every page returned "${summary.errors[0]?.reason ?? 'HTTP 403'}" (bot protection such as Cloudflare). The crawler respects that and stopped after ${summary.visited} pages. To include this site, ask its owner to allow the crawler, or upload the content (for example a PDF or exported list) as a document.`;
    } else if (searchable === 0) {
      // Saved is not ingested: with no searchable documents this must not read as success.
      status = JobStatus.FAILED;
      const parts = [`No indexable content was found (${summary.visited} page${summary.visited === 1 ? '' : 's'} visited).`];
      if (summary.failed) parts.push(`${summary.failed} failed to load — first: ${summary.errors[0]?.reason ?? 'unknown error'}.`);
      if (tally.jsLimited) parts.push(`${tally.jsLimited} appear to need JavaScript rendering, which is not supported.`);
      if (tally.lowValue - tally.jsLimited > 0) parts.push(`${tally.lowValue - tally.jsLimited} had too little text to index.`);
      if (summary.skippedByRobots) parts.push(`${summary.skippedByRobots} were blocked by robots.txt.`);
      if (tally.indexFailures) parts.push(`${tally.indexFailures} could not be embedded or indexed.`);
      note = parts.join(' ');
    } else if (failures > 0 || stoppedByBudget) {
      status = JobStatus.PARTIAL;
      const parts = [`${searchable} document${searchable === 1 ? ' is' : 's are'} searchable.`];
      if (summary.failed) parts.push(`${summary.failed} page${summary.failed === 1 ? '' : 's'} failed (first: ${summary.errors[0]?.reason ?? 'unknown'}).`);
      if (tally.indexFailures) parts.push(`${tally.indexFailures} could not be indexed.`);
      if (tally.pdfFailures) parts.push(`${tally.pdfFailures} PDF${tally.pdfFailures === 1 ? '' : 's'} failed.`);
      if (stoppedByBudget) parts.push(`Stopped early: ${summary.budgetExhausted === 'bytes' ? 'download-size' : 'time'} budget reached.`);
      note = parts.join(' ');
    }

    settleStages(tracker.progress, status === JobStatus.FAILED || cancelled ? 'failed' : 'completed');
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status, error: note ? note.slice(0, 2000) : null, finishedAt: new Date() },
    });
    // "Last crawled" means last *successful* crawl: a run that ingested nothing does not count.
    if (status === JobStatus.COMPLETED || status === JobStatus.PARTIAL) {
      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { lastCrawledAt: new Date() },
      });
    }

    log.info('Crawl job finished', tracker.counters as unknown as Record<string, unknown>);
  } catch (err) {
    const message = describeError(err);
    tracker.log('error', message);
    settleStages(tracker.progress, 'failed');
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: JobStatus.FAILED, error: message.slice(0, 2000), finishedAt: new Date() },
    });
    throw err;
  }
}

function outcomeCounters(outcome: UpsertOutcome, chunks = 0) {
  return {
    documentsCreated: outcome.action === 'created' ? 1 : 0,
    documentsUpdated: outcome.action === 'updated' ? 1 : 0,
    documentsSkipped: outcome.action === 'unchanged' || outcome.action === 'skipped' ? 1 : 0,
    chunksIndexed: chunks,
  };
}

/**
 * Fails upload jobs whose request died mid-flight.
 *
 * An upload job is RUNNING from the moment it is created and is never queued,
 * so nothing would ever pick it up again. Any such row older than `olderThanMs`
 * belongs to a request that crashed or timed out. Marking it FAILED (rather
 * than retrying) is correct: the bytes were never stored, so the file must be
 * uploaded again.
 */
export async function failInterruptedUploads(olderThanMs = STALE_RUN_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.ingestionJob.updateMany({
    where: {
      type: JobType.PDF_INGEST,
      status: JobStatus.RUNNING,
      startedAt: { lt: cutoff },
      params: { path: ['upload'], equals: true },
    },
    data: {
      status: JobStatus.FAILED,
      finishedAt: new Date(),
      errorCount: 1,
      error: 'Upload interrupted before it finished (the server stopped mid-request). Upload the file again.',
    },
  });
  if (count > 0) logger.warn('Marked interrupted upload jobs as failed', { count });
  return count;
}

/**
 * An uploaded PDF as a tracked job.
 *
 * The bytes exist only in this request, so the job is created already RUNNING
 * and is never put on the queue — a worker cannot pick it up, and the file is
 * ingested exactly once. The row gives uploads the same history, counters and
 * error text as every other ingestion.
 */
export async function ingestPdfUploadTracked(
  buffer: ArrayBuffer,
  filename: string,
  opts: Parameters<typeof ingestPdfUpload>[2] & { requestedBy?: string } = {},
): Promise<UpsertOutcome & { chunks: number; jobId: string }> {
  const job = await prisma.ingestionJob.create({
    data: {
      type: JobType.PDF_INGEST,
      sourceId: opts.sourceId ?? null,
      status: JobStatus.RUNNING,
      startedAt: new Date(),
      params: { upload: true, filename, bytes: buffer.byteLength } as Prisma.InputJsonValue,
    },
  });
  try {
    const result = await ingestPdfUpload(buffer, filename, opts);
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: {
        status: JobStatus.COMPLETED,
        finishedAt: new Date(),
        pagesDiscovered: 1,
        pagesProcessed: 1,
        ...outcomeCounters(result, result.chunks),
      },
    });
    return { ...result, jobId: job.id };
  } catch (err) {
    const message = describeError(err);
    await prisma.ingestionJob
      .update({
        where: { id: job.id },
        data: { status: JobStatus.FAILED, error: message.slice(0, 2000), finishedAt: new Date(), errorCount: 1 },
      })
      .catch(() => undefined);
    throw err;
  }
}

export async function ingestPdfFromUrl(
  url: string,
  sourceId?: string | null,
  hooks?: IndexHooks,
  inScope?: (url: URL) => boolean,
): Promise<UpsertOutcome> {
  const pdf = await fetchAndExtractPdf(url, { inScope });
  const outcome = await upsertDocument({
    url,
    title: pdf.title,
    text: pdf.text,
    type: DocumentType.PDF,
    sourceId,
    publishedAt: pdf.publishedAt,
  });
  if (outcome.action === 'created' || outcome.action === 'updated') {
    await indexDocument(outcome.documentId, hooks);
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
    // A re-index starts from documents already stored, so only these stages apply.
    patchStage(tracker.progress, 'discover', { state: 'completed', done: documents.length, total: documents.length });
    patchStage(tracker.progress, 'extract', { state: 'skipped' });
    for (const id of ['chunk', 'embed', 'index'] as const) {
      patchStage(tracker.progress, id, { total: documents.length, state: documents.length ? 'running' : 'skipped' });
    }
    await tracker.flush(true);

    for (const document of documents) {
      if (await wasCancelled(jobId)) break;
      try {
        const { chunks } = await indexDocument(document.id, tracker.indexHooks());
        tracker.counters.chunksIndexed += chunks;
        tracker.counters.documentsUpdated++;
      } catch (err) {
        tracker.log('error', `${document.title}: ${describeError(err, 500)}`);
        for (const id of ['chunk', 'embed', 'index'] as const) bumpStage(tracker.progress, id, { errors: 1 });
      }
      tracker.counters.pagesProcessed++;
      await tracker.flush();
    }

    settleStages(tracker.progress, 'completed');
    await tracker.flush(true);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: (await wasCancelled(jobId)) ? JobStatus.CANCELLED : JobStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const message = describeError(err);
    tracker.log('error', message);
    settleStages(tracker.progress, 'failed');
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

  // Claim the job before doing any work. Two workers, a stalled-job
  // redelivery, or a retry can all deliver the same id more than once; the
  // row is the authority on who owns it.
  const decision = decideClaim(job);
  if (decision.kind === 'terminal') {
    logger.info('Ingestion job already finished; acknowledging duplicate delivery', {
      jobId,
      status: decision.status,
    });
    return;
  }
  if (decision.kind === 'in_flight') {
    // Never acknowledge this as success: the queue would drop the job while
    // the row stays RUNNING and nothing would ever resume it.
    logger.warn('Ingestion job is owned by a live run; deferring', { jobId });
    throw new JobInFlightError(jobId, decision.retryAfterMs);
  }

  // The state can change between the read above and this write, so the claim
  // itself is a compare-and-set; only one concurrent caller can win it.
  const stale = new Date(Date.now() - STALE_RUN_MS);
  const claimed = await prisma.ingestionJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: { in: [JobStatus.QUEUED, JobStatus.FAILED] } },
        { status: JobStatus.RUNNING, startedAt: { lt: stale } },
      ],
    },
    data: { status: JobStatus.RUNNING, startedAt: new Date(), error: null, finishedAt: null },
  });
  if (claimed.count === 0) {
    const current = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
    const again = current ? decideClaim(current) : ({ kind: 'terminal', status: 'MISSING' } as const);
    if (again.kind === 'in_flight') throw new JobInFlightError(jobId, again.retryAfterMs);
    logger.info('Ingestion job was claimed or finished by another delivery', { jobId });
    return;
  }

  switch (job.type) {
    case JobType.CRAWL:
      return runCrawlJob(jobId);
    case JobType.REINDEX:
    case JobType.FULL_REBUILD: {
      const params = (job.params ?? {}) as { documentIds?: string[] };
      return runReindexJob(jobId, params.documentIds);
    }
    case JobType.PDF_INGEST:
    case JobType.DELETE_DOCUMENT:
      // Crawl and reindex record their own failures; these two did not, so an
      // error left the row RUNNING forever — which also kept the console's
      // crawl buttons disabled. Any throw now ends the job as FAILED.
      try {
        if (job.type === JobType.PDF_INGEST) {
          const params = (job.params ?? {}) as { url?: string };
          // Rows created before validation existed (or by hand) get the same check.
          const url = validatePdfUrl(params.url);
          const outcome = await ingestPdfFromUrl(url, job.sourceId);
          await prisma.ingestionJob.update({
            where: { id: jobId },
            data: { status: JobStatus.COMPLETED, finishedAt: new Date(), ...outcomeCounters(outcome) },
          });
        } else {
          const params = (job.params ?? {}) as { documentId?: string };
          if (!params.documentId) throw new Error('DELETE_DOCUMENT job requires a documentId');
          await deleteDocument(params.documentId);
          await prisma.ingestionJob.update({
            where: { id: jobId },
            data: { status: JobStatus.COMPLETED, finishedAt: new Date() },
          });
        }
      } catch (err) {
        const message = describeError(err);
        logger.error('Ingestion job failed', { jobId, type: job.type, error: message });
        await prisma.ingestionJob.update({
          where: { id: jobId },
          data: { status: JobStatus.FAILED, error: message.slice(0, 2000), finishedAt: new Date() },
        });
        throw err; // the worker decides retry vs. give up (see isPermanentJobError)
      }
      return;
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
  /** Points in Qdrant; null when the vector store cannot be reached. */
  vectorsInQdrant: number | null;
  /** Qdrant points with no matching chunk row (stale or orphaned). */
  orphanVectors: number | null;
}> {
  const [indexedDocuments, chunksInDb, chunksWithVectors, stats] = await Promise.all([
    prisma.document.count({ where: { status: DocumentStatus.INDEXED } }),
    prisma.documentChunk.count(),
    prisma.documentChunk.count({ where: { vectorId: { not: null } } }),
    collectionStats(),
  ]);
  const vectorsInQdrant = stats.exists ? stats.vectorCount : null;
  return {
    indexedDocuments,
    chunksInDb,
    chunksWithVectors,
    missingVectors: chunksInDb - chunksWithVectors,
    vectorsInQdrant,
    orphanVectors: vectorsInQdrant === null ? null : vectorsInQdrant - chunksWithVectors,
  };
}
