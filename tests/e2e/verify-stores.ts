/**
 * READ-ONLY verification of PostgreSQL + Qdrant after the recorded upload.
 *
 * Performs no writes of any kind. Every number here is read back from the live
 * stores the application itself is using, so the report can cite measurements
 * rather than assumptions.
 *
 *   npx tsx tests/e2e/verify-stores.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { embedQuery } from '../../src/lib/ai/embeddings';
import { searchVectors } from '../../src/lib/vector/qdrant';
import { env } from '../../src/lib/env';

const prisma = new PrismaClient();
const ANCHOR = 'GOLDENSIERRA-QA-ANCHOR-8842';

type Check = { name: string; expected: string; actual: string; pass: boolean };
const checks: Check[] = [];
const add = (name: string, expected: string, actual: string, pass: boolean) => {
  checks.push({ name, expected, actual, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}\n      expected: ${expected}\n      actual  : ${actual}`);
};

async function main() {
  // ── TASK 4: PostgreSQL ────────────────────────────────────────────────
  console.log('\n── PostgreSQL ──────────────────────────────────────────');

  const doc = await prisma.document.findFirst({
    where: { url: { contains: 'QA-Test-Workforce' } },
    include: { chunks: { orderBy: { ordinal: 'asc' } }, source: true },
  });

  if (!doc) {
    add('document row exists', 'one row for QA-Test-Workforce-Data.pdf', 'NOT FOUND', false);
    writeFileSync('test-artifacts/store-verification.json', JSON.stringify({ checks }, null, 2));
    return;
  }

  add('document row exists', 'present', `id=${doc.id}`, true);
  add('document title', 'QA-Test-Workforce-Data', doc.title, doc.title.includes('QA-Test'));
  add('document type', 'PDF', doc.type, doc.type === 'PDF');
  add('indexing status', 'INDEXED', doc.status, doc.status === 'INDEXED');
  add('extracted content stored', '> 500 chars', `${doc.content.length} chars`, doc.content.length > 500);
  add('anchor token in stored text', ANCHOR, doc.content.includes(ANCHOR) ? 'present' : 'absent', doc.content.includes(ANCHOR));
  add('chunk count', '> 0', String(doc.chunks.length), doc.chunks.length > 0);
  add(
    'every chunk embedded',
    `${doc.chunks.length}/${doc.chunks.length}`,
    `${doc.chunks.filter((c) => c.vectorId).length}/${doc.chunks.length}`,
    doc.chunks.every((c) => c.vectorId),
  );
  add(
    'embedding model recorded',
    env.EMBEDDING_MODEL,
    doc.chunks[0]?.embeddingModel ?? 'null',
    doc.chunks[0]?.embeddingModel === env.EMBEDDING_MODEL,
  );
  add('sourceId', 'may be null for a direct upload', doc.sourceId ?? 'null', true);
  add('timestamps', 'createdAt + updatedAt set', `${doc.createdAt.toISOString()} / ${doc.updatedAt.toISOString()}`, true);
  add('audience classification', 'job_seeker or both (these are job listings)', doc.audience ?? 'null',
      doc.audience === 'job_seeker' || doc.audience === 'both');
  add('category classification', 'a workforce category', doc.category ?? 'null', Boolean(doc.category));
  add('access level', 'PUBLIC', doc.accessLevel, doc.accessLevel === 'PUBLIC');

  // ── TASK 5: Qdrant ────────────────────────────────────────────────────
  console.log('\n── Qdrant ──────────────────────────────────────────────');

  const base = env.QDRANT_URL;
  const info = await fetch(`${base}/collections/${env.QDRANT_COLLECTION}`).then((r) => r.json());
  const cfg = info.result?.config?.params?.vectors;
  add('collection exists', env.QDRANT_COLLECTION, info.result ? 'present' : 'missing', Boolean(info.result));
  add('vector dimensions', String(env.EMBEDDING_DIMENSIONS), String(cfg?.size), cfg?.size === env.EMBEDDING_DIMENSIONS);
  add('collection status', 'green', info.result?.status ?? '?', info.result?.status === 'green');

  const counted = await fetch(`${base}/collections/${env.QDRANT_COLLECTION}/points/count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { must: [{ key: 'documentId', match: { value: doc.id } }] }, exact: true }),
  }).then((r) => r.json());
  const vectorCount = counted.result?.count ?? 0;
  add('vectors for this document', String(doc.chunks.length), String(vectorCount), vectorCount === doc.chunks.length);

  const scrolled = await fetch(`${base}/collections/${env.QDRANT_COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ key: 'documentId', match: { value: doc.id } }] },
      limit: 1,
      with_payload: true,
    }),
  }).then((r) => r.json());
  const payload = scrolled.result?.points?.[0]?.payload ?? {};
  add('payload: documentId', doc.id, String(payload.documentId), payload.documentId === doc.id);
  add('payload: title', doc.title, String(payload.title), payload.title === doc.title);
  add('payload: documentType', 'PDF', String(payload.documentType), payload.documentType === 'PDF');
  add('payload: audience', doc.audience ?? '', String(payload.audience), payload.audience === doc.audience);
  add('payload: accessLevel', 'PUBLIC', String(payload.accessLevel), payload.accessLevel === 'PUBLIC');

  // ── TASK 5: similarity search reaches the new vectors ─────────────────
  console.log('\n── Similarity search ───────────────────────────────────');

  const vec = await embedQuery(`QA verification anchor token ${ANCHOR}`);

  const unfiltered = await searchVectors(vec, 10, { accessLevels: ['PUBLIC'], language: 'en' }, 0.25);
  const unfilteredHits = unfiltered.filter((h) => h.payload.documentId === doc.id);
  add('retrievable, no audience filter', '>= 1 chunk', `${unfilteredHits.length} of ${unfiltered.length}`, unfilteredHits.length > 0);
  if (unfilteredHits[0]) {
    console.log(`      top score: ${unfilteredHits[0].score.toFixed(4)}`);
    console.log(`      snippet  : ${unfilteredHits[0].payload.content.slice(0, 120).replace(/\n/g, ' ')}…`);
  }

  // This is the filter the chat pipeline applies once a user says they are
  // looking for work — the exact condition that hid Scrapedata.pdf.
  const asJobSeeker = await searchVectors(
    vec, 10, { accessLevels: ['PUBLIC'], language: 'en', audiences: ['job_seeker', 'both'] }, 0.25,
  );
  const jobSeekerHits = asJobSeeker.filter((h) => h.payload.documentId === doc.id);
  add('retrievable with audience=job_seeker', '>= 1 chunk', `${jobSeekerHits.length} of ${asJobSeeker.length}`, jobSeekerHits.length > 0);

  const asEmployer = await searchVectors(
    vec, 10, { accessLevels: ['PUBLIC'], language: 'en', audiences: ['employer', 'both'] }, 0.25,
  );
  const employerHits = asEmployer.filter((h) => h.payload.documentId === doc.id);
  console.log(`      audience=employer: ${employerHits.length} of ${asEmployer.length}`);

  // ── Regression check on the previously reported Scrapedata issue ──────
  console.log('\n── Previously reported issue: Scrapedata.pdf audience ──');
  const scrape = await prisma.document.findFirst({ where: { title: { contains: 'Scrapedata' } } });
  if (scrape) {
    add(
      'Scrapedata.pdf audience fixed',
      'job_seeker or both',
      scrape.audience ?? 'null',
      scrape.audience === 'job_seeker' || scrape.audience === 'both',
    );
  } else {
    console.log('      Scrapedata.pdf not present in this database');
  }

  // ── Totals ────────────────────────────────────────────────────────────
  const [docs, chunks] = await Promise.all([prisma.document.count(), prisma.documentChunk.count()]);
  const total = await fetch(`${base}/collections/${env.QDRANT_COLLECTION}`).then((r) => r.json());
  add(
    'PostgreSQL/Qdrant consistency',
    'chunk count === point count',
    `${chunks} chunks / ${total.result?.points_count} points`,
    chunks === total.result?.points_count,
  );
  console.log(`\n  corpus: ${docs} documents, ${chunks} chunks, ${total.result?.points_count} vectors`);

  writeFileSync(
    'test-artifacts/store-verification.json',
    JSON.stringify(
      {
        document: {
          id: doc.id, title: doc.title, url: doc.url, type: doc.type, status: doc.status,
          audience: doc.audience, category: doc.category, wordCount: doc.wordCount,
          contentChars: doc.content.length, chunks: doc.chunks.length,
          embeddingModel: doc.chunks[0]?.embeddingModel,
          createdAt: doc.createdAt, updatedAt: doc.updatedAt,
        },
        qdrant: { collection: env.QDRANT_COLLECTION, dimensions: cfg?.size, vectorsForDoc: vectorCount, totalPoints: total.result?.points_count },
        retrieval: {
          noFilter: unfilteredHits.length, asJobSeeker: jobSeekerHits.length, asEmployer: employerHits.length,
          topScore: unfilteredHits[0]?.score ?? null,
        },
        scrapedataAudience: scrape?.audience ?? null,
        checks,
      },
      null, 2,
    ),
  );

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) console.log('  failed: ' + failed.map((f) => f.name).join('; '));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
