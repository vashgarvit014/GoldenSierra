/**
 * Recomputes audience/category for existing documents and re-indexes only the
 * ones that actually change.
 *
 * Non-destructive: nothing is deleted, and content is never touched. The
 * re-index is required because audience lives in the Qdrant payload too — a
 * database-only update would leave retrieval filtering on the old value.
 *
 *   npm run reclassify -- --dry-run   (default: shows the diff, writes nothing)
 *   npm run reclassify -- --apply
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { detectAudience, detectCategory, isJobListing } from '../src/lib/ingest/clean';
import { indexDocument } from '../src/lib/ingest/pipeline';

const apply = process.argv.includes('--apply');

async function main() {
  const docs = await prisma.document.findMany({
    where: { status: { in: ['INDEXED', 'EXTRACTED'] } },
    select: { id: true, title: true, url: true, content: true, audience: true, category: true },
  });

  const changes = docs
    .map((d) => ({
      doc: d,
      audience: detectAudience(d.url, d.title, d.content),
      category: detectCategory(d.url, d.title, d.content),
      listing: isJobListing(d.title, d.content),
    }))
    .filter((c) => c.audience !== c.doc.audience || c.category !== c.doc.category);

  console.log(`${changes.length} of ${docs.length} documents would be reclassified\n`);
  for (const c of changes) {
    console.log(
      `  ${c.listing ? '[listing] ' : '          '}${c.doc.title.slice(0, 38).padEnd(38)} ` +
        `${c.doc.audience}/${c.doc.category}  ->  ${c.audience}/${c.category}`,
    );
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write and re-index.');
    return;
  }

  console.log('\nApplying…');
  let reindexed = 0;
  for (const c of changes) {
    await prisma.document.update({
      where: { id: c.doc.id },
      data: { audience: c.audience, category: c.category },
    });
    // Rewrites the vector payload so both stores agree.
    const { chunks } = await indexDocument(c.doc.id);
    reindexed += chunks;
    console.log(`  ✓ ${c.doc.title.slice(0, 44)} (${chunks} chunks)`);
  }
  console.log(`\nDone — ${changes.length} documents, ${reindexed} chunks re-indexed.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
