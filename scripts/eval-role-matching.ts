/**
 * Role-aware job matching vs. baselines, on a small hand-labelled set (read only).
 *
 *   keyword   a listing is returned if any content word of the message (4+ letters, not a stopword)
 *             appears in its title, skills or summary — keyword-only matching
 *   vector    the existing Qdrant retrieval on the message (top 8 chunks, PostgreSQL-validated); a
 *             listing is returned if a retrieved chunk contains its title
 *   role      the Navigator: rule extraction → occupation taxonomy → scoreListings (no LLM)
 *
 * Labels: a listing is relevant when its occupation is the role described or a reasonable next move from
 * it (same occupation, adjacent occupation, or a lead role in the same line of work). The labels are a
 * judgement made for this evaluation and are listed below so they can be challenged. 12 listings, 10 cases.
 *
 *   npx tsx scripts/eval-role-matching.ts
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';
import { retrieve } from '../src/lib/rag/retrieve';
import { validateChunks } from '../src/lib/rag/strict';
import { loadListings, scoreListings } from '../src/lib/jobs/match';
import { mergeContext, ruleExtract } from '../src/lib/counselor/extract';
import type { CounselorContext } from '../src/types/counselor';
import type { QueryAnalysis } from '../src/types/chat';

const CASES: { message: string; relevant: string[] }[] = [
  { message: 'I have experience installing solar panels and want a better job.', relevant: ['Electrician', 'Traffic Control & Lighting Technician I/II'] },
  { message: 'For five years I helped elderly people at home with bathing, dressing and meal preparation.', relevant: ['In-Home Senior Care (Caregiver)'] },
  { message: 'I did bookkeeping in QuickBooks, invoices and accounts payable for a small company.', relevant: ['Accounting Assistant'] },
  { message: "I'm interested in healthcare work.", relevant: ['In-Home Senior Care (Caregiver)'] },
  { message: 'I want to work in IT. I troubleshoot networks and build database reports.', relevant: ['Information Technology Specialist - Senior'] },
  { message: 'I supervised a team of housekeepers at a hotel.', relevant: ['Housekeeping Manager'] },
  { message: "I've been an instructional aide in a classroom, tutoring students.", relevant: ['Education Support Specialist'] },
  { message: 'I was an office receptionist answering phones, filing and doing data entry.', relevant: ['Administrative Legal Clerk - Entry', 'Executive Assistant'] },
  { message: 'I sold cars for years and want to lead a sales team now.', relevant: ['Sales Manager'] },
  { message: 'I want to work as a deep sea saturation diver.', relevant: [] },
];

const STOP = new Set('have want with from that this what work worked working years year experience better job jobs doing into been some them they their about would like more help helped people home small company team'.split(' '));
const words = (m: string) => [...new Set(m.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((w) => !STOP.has(w));

function prf(got: string[], relevant: string[]) {
  const tp = got.filter((g) => relevant.includes(g)).length;
  return { tp, fp: got.length - tp, fn: relevant.length - tp };
}

(async () => {
  const rows = await loadListings();
  const chunks = await prisma.documentChunk.findMany({ where: { documentId: { in: [...new Set(rows.map((r) => r.documentId))] } }, select: { id: true, content: true } });
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const totals = { keyword: { tp: 0, fp: 0, fn: 0 }, vector: { tp: 0, fp: 0, fn: 0 }, role: { tp: 0, fp: 0, fn: 0 }, roleBest: { tp: 0, fp: 0, fn: 0 } };
  const perCase = [];
  for (const c of CASES) {
    const kw = words(c.message);
    const keyword = rows.filter((r) => kw.some((w) => `${r.title} ${r.requiredSkills ?? ''} ${r.summary ?? ''}`.toLowerCase().includes(w))).map((r) => r.title);

    const analysis = { intent: 'find_job', confidence: 0.8, rewrittenQuery: c.message, keywords: [], profileUpdates: {}, missingInfo: null, isMultiPart: false, subQuestions: [] } as unknown as QueryAnalysis;
    const r = await retrieve(analysis, {}, { expand: false });
    const { valid } = await validateChunks(r.sources);
    const top = valid.slice(0, 8);
    const vector = rows.filter((l) => top.some((s) => squash(chunks.find((ch) => ch.id === s.chunkId)?.content ?? s.snippet).includes(squash(l.title)))).map((l) => l.title);

    let ctx: CounselorContext = { mode: 'self', population: [], barriers: [] };
    ctx = mergeContext(ctx, ruleExtract(c.message, ctx));
    const scored = scoreListings(rows, ctx);
    const role = scored.map((m) => m.title);
    // What the UI shows under "Best job matches" (exact role); related roles are shown separately.
    const roleBest = scored.filter((m) => m.kind === 'exact').map((m) => m.title);

    const res = { keyword: prf(keyword, c.relevant), vector: prf(vector, c.relevant), role: prf(role, c.relevant), roleBest: prf(roleBest, c.relevant) };
    for (const k of ['keyword', 'vector', 'role', 'roleBest'] as const) for (const f of ['tp', 'fp', 'fn'] as const) totals[k][f] += res[k][f];
    perCase.push({ message: c.message, relevant: c.relevant, keyword, vector, role, res });
    console.log(`\n${c.message}\n  relevant: ${c.relevant.join(' | ') || '(none)'}\n  keyword : ${keyword.join(' | ') || '—'}\n  vector  : ${vector.join(' | ') || '—'}\n  role    : ${role.join(' | ') || '—'}`);
  }
  const summary = Object.fromEntries(
    Object.entries(totals).map(([k, t]) => [k, { precision: +(t.tp / Math.max(1, t.tp + t.fp)).toFixed(2), recall: +(t.tp / Math.max(1, t.tp + t.fn)).toFixed(2), falsePositives: t.fp, ...t }]),
  );
  console.log('\nSUMMARY (micro-averaged over 10 cases, 12 listings)');
  console.table(summary);
  writeFileSync('test-artifacts/role-matching-eval.json', JSON.stringify({ summary, perCase }, null, 2));
  await prisma.$disconnect();
})();
