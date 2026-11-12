/**
 * Runs ingestion from the command line.
 *
 *   npm run ingest                 # crawl every ACTIVE source
 *   npm run ingest -- --source=<id>
 *   npm run ingest -- --reindex    # re-embed existing documents
 *   npm run ingest -- --url=<pdf>  # ingest one PDF
 */
import 'dotenv/config';
import { JobType, SourceStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { createJob, runJob, auditIndex, ingestPdfFromUrl } from '../src/lib/ingest/pipeline';
import { ensureCollection, collectionStats } from '../src/lib/vector/qdrant';
import { hasEmbeddings } from '../src/lib/env';

function arg(name: string): string | undefined {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match?.split('=').slice(1).join('=');
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  if (!hasEmbeddings()) {
    console.error(
      'No embedding credentials found. Set EMBEDDING_API_KEY (or LLM_API_KEY) in .env before indexing.',
    );
    process.exit(1);
  }

  await ensureCollection();

  const pdfUrl = arg('url');
  if (pdfUrl) {
    console.log(`Ingesting PDF: ${pdfUrl}`);
    const result = await ingestPdfFromUrl(pdfUrl);
    console.log(`  ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
    return report();
  }

  if (flag('reindex')) {
    const jobId = await createJob(JobType.REINDEX);
    console.log(`Re-indexing all documents (job ${jobId})…`);
    await runJob(jobId);
    return report();
  }

  const sourceId = arg('source');
  const sources = sourceId
    ? await prisma.knowledgeSource.findMany({ where: { id: sourceId } })
    : await prisma.knowledgeSource.findMany({
        where: { status: SourceStatus.ACTIVE, rootUrl: { not: null } },
      });

  if (sources.length === 0) {
    console.error('No crawlable sources found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  for (const source of sources) {
    console.log(`\nCrawling "${source.name}" (${source.rootUrl})…`);
    const jobId = await createJob(JobType.CRAWL, source.id);

    const started = Date.now();
    try {
      await runJob(jobId);
    } catch (err) {
      console.error(`  failed: ${err instanceof Error ? err.message : err}`);
    }

    const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
    console.log(
      `  ${job?.status} in ${Math.round((Date.now() - started) / 1000)}s — ` +
        `${job?.documentsCreated} new, ${job?.documentsUpdated} updated, ` +
        `${job?.documentsSkipped} unchanged, ${job?.chunksIndexed} chunks, ${job?.errorCount} errors`,
    );
  }

  await report();
}

async function report() {
  const [index, vector] = await Promise.all([auditIndex(), collectionStats()]);
  console.log('\n── Index state ──');
  console.log(`  Documents indexed : ${index.indexedDocuments}`);
  console.log(`  Chunks in Postgres: ${index.chunksInDb}`);
  console.log(`  Chunks embedded   : ${index.chunksWithVectors}`);
  console.log(`  Vectors in Qdrant : ${vector.vectorCount}`);
  if (index.missingVectors > 0) {
    console.warn(`  ⚠ ${index.missingVectors} chunks have no vector — re-run with --reindex`);
  }
}

main()
  .catch((err) => {
    console.error('\nIngestion failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
