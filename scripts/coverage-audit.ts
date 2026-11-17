/**
 * Knowledge coverage audit (read only).
 *
 * For each topic the guided conversation depends on, reports:
 *   1. keyword evidence: indexed, public chunks whose text mentions the topic (PostgreSQL regex), and
 *   2. what the real guided retrieval returns for that need (Qdrant → PostgreSQL validation → relevance gate).
 * A topic with no keyword evidence, or whose retrieved passages only mention it in passing, is a gap to
 * fill with an authoritative source. Nothing is written.
 *
 *   npx tsx scripts/coverage-audit.ts [--json]
 */
import { prisma } from '../src/lib/db';
import { prepareGuidedResults } from '../src/lib/conversation/evidence';
import type { CounselorContext } from '../src/types/counselor';

type Topic = { key: string; label: string; pattern: string; ctx: Partial<CounselorContext>; message?: string };

const TOPICS: Topic[] = [
  { key: 'ged', label: 'GED / high school equivalency', pattern: String.raw`\m(GED|HiSET|high school equivalen\w*|adult (school|education)|high school diploma)\M`, ctx: { education: 'no_hs_diploma' } },
  { key: 'youth', label: 'Youth workforce services (16–24)', pattern: String.raw`\m(youth (program|services|employment)|WIOA youth|young adults?|ages? 16|16\s*(-|–|to)\s*24)\M`, ctx: { ageBand: '18_24' } },
  { key: 'foster', label: 'Former foster youth', pattern: String.raw`\mfoster\M`, ctx: { population: ['former_foster_youth'] } },
  { key: 'healthcare', label: 'Healthcare training', pattern: String.raw`\m(CNA|certified nursing|nursing assistant|medical assistant|phlebotom\w*|healthcare (training|career\w*)|allied health)\M`, ctx: { careerInterest: 'healthcare' } },
  { key: 'transport', label: 'Transportation assistance', pattern: String.raw`\m(transportation (assistance|support|help)|bus pass\w*|gas card\w*|mileage reimburse\w*|supportive services)\M`, ctx: {}, message: 'transportation assistance bus passes gas cards help getting to work or training' },
];

async function main() {
  const json = process.argv.includes('--json');
  const report = [];
  for (const t of TOPICS) {
    const rows = await prisma.$queryRawUnsafe<{ title: string; url: string | null; n: bigint; sample: string }[]>(
      `select d.title, d.url, count(*) as n, min(substring(c.content from '(?i)[^.]{0,80}' || $1 || '[^.]{0,80}')) as sample
         from "DocumentChunk" c join "Document" d on d.id = c."documentId"
        where d.status = 'INDEXED' and d."accessLevel" = 'PUBLIC' and c.content ~* $1
        group by d.title, d.url order by count(*) desc limit 8`,
      t.pattern,
    );
    const ctx: CounselorContext = { mode: 'self', population: [], barriers: [], ...t.ctx };
    const { prepared } = await prepareGuidedResults(ctx, t.message ?? t.label);
    const retrieved = prepared.usedSources.map((s) => ({ title: s.title, url: s.url, mentionsTopic: new RegExp(t.pattern.replace(/\\m|\\M/g, '\\b'), 'i').test(s.snippet) }));
    report.push({
      topic: t.label,
      keywordDocuments: rows.length,
      keywordChunks: rows.reduce((n, r) => n + Number(r.n), 0),
      documents: rows.map((r) => ({ title: r.title, url: r.url, chunks: Number(r.n), sample: r.sample?.replace(/\s+/g, ' ').trim() ?? null })),
      retrieved,
      retrievedOnTopic: retrieved.filter((r) => r.mentionsTopic).length,
    });
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const r of report) {
      console.log(`\n■ ${r.topic}: ${r.keywordChunks} chunk(s) in ${r.keywordDocuments} document(s); guided retrieval ${r.retrieved.length} passage(s), ${r.retrievedOnTopic} on topic`);
      for (const d of r.documents) console.log(`   · ${d.title} — ${d.url} (${d.chunks})\n       “${(d.sample ?? '').slice(0, 170)}”`);
      for (const x of r.retrieved) console.log(`   ↳ retrieved: ${x.title} — ${x.url}${x.mentionsTopic ? '' : '  [does not mention the topic]'}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
