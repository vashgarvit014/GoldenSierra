/**
 * Links catalogue programs to the indexed documents that name them (ProgramDocument rows).
 * Additive and idempotent; re-run after a re-crawl. Nothing in the knowledge base is changed.
 *
 *   npm run programs:link            # write links
 *   npm run programs:link -- --dry   # show what would be linked
 */
import { prisma } from '../src/lib/db';
import { linkProgramsToDocuments } from '../src/lib/programs/link';

(async () => {
  const dryRun = process.argv.includes('--dry');
  const plans = await linkProgramsToDocuments({ dryRun });
  for (const p of plans) {
    console.log(`${p.slug}: ${p.documents.length} document(s)${p.documents.length ? '' : '  ← no indexed page names this program'}`);
    for (const d of p.documents) console.log(`   "${d.phrase}"  ${d.url}`);
  }
  console.log(dryRun ? '\n(dry run — nothing written)' : `\nlinks now stored: ${await prisma.programDocument.count()}`);
  await prisma.$disconnect();
})();
