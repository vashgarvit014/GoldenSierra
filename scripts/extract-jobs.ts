/**
 * Extracts structured job listings from indexed listing tables into JobListing (derived data only;
 * source documents and chunks are never modified). Re-run after re-indexing a listing document.
 *
 *   npm run jobs:extract            # rebuild
 *   npm run jobs:extract -- --dry   # report only
 */
import { prisma } from '../src/lib/db';
import { extractJobListings } from '../src/lib/jobs/extract';

(async () => {
  const dryRun = process.argv.includes('--dry');
  const reports = await extractJobListings({ dryRun });
  for (const r of reports) console.log(`${r.document}: ${r.listings} listing(s), ${r.droppedFields} unverifiable field(s) dropped${r.skipped.length ? `, skipped ${JSON.stringify(r.skipped)}` : ''}`);
  if (!dryRun) {
    for (const j of await prisma.jobListing.findMany({ orderBy: [{ documentId: 'asc' }, { ordinal: 'asc' }] })) {
      console.log(`  ${j.ordinal}. ${j.title} | ${j.employer ?? '—'} | ${j.county ?? '—'} | ${j.salary ?? '—'} | occ=${j.occupations.join(',') || '—'} | deadline=${j.deadline ?? '—'} | apply=${j.applyUrl ? 'yes' : 'no'}`);
    }
  }
  await prisma.$disconnect();
})();
