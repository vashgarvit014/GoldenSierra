/**
 * Public counselor (/api/session) results are grounded exactly like the admin guided chat:
 * every [n] in the message is a listed source, every source is an indexed public document,
 * every card is a catalogue program linked to a cited document whose chunk names it, and the card
 * text is quoted from that document. An unsupported need gets no cards and no invented service.
 *
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/session-grounding.ts
 */
import 'dotenv/config';
import { prisma } from '../../src/lib/db';
import { namedIn } from '../../src/lib/programs/link';
import type { CounselorTurn } from '../../src/types/counselor';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
};

async function session(mode: 'self' | 'helper') {
  const start = (await (await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })).json()) as { sessionId: string; sessionToken: string };
  const say = async (message: string, forceResults = false) => {
    const res = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionToken: start.sessionToken, message, forceResults }) });
    return ((await res.json()) as { turn: CounselorTurn }).turn;
  };
  return { id: start.sessionId, say };
}

async function verify(label: string, t: CounselorTurn) {
  const cited = [...t.message.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  check(`${label}: every [n] in the message is a listed source`, cited.every((n) => t.sources.some((s) => s.id === n)), JSON.stringify({ cited, sources: t.sources.map((s) => s.id) }));
  const docs = await prisma.document.findMany({ where: { url: { in: t.sources.map((s) => s.url!).filter(Boolean) } }, include: { chunks: { select: { content: true, headingPath: true } } } });
  check(`${label}: every source is an indexed, public document`, t.sources.every((s) => docs.some((d) => d.url === s.url && d.status === 'INDEXED' && d.accessLevel === 'PUBLIC')), JSON.stringify(t.sources));
  for (const card of t.recommendations) {
    // Job cards come from extracted job listings (verified verbatim at extraction), not the program catalogue.
    if (card.slug.startsWith('job-')) {
      const row = await prisma.jobListing.findUnique({ where: { id: card.slug.slice(4) }, include: { document: true } });
      const ok = Boolean(row && card.name.startsWith(row.title) && row.segment.includes(row.title) && [row.applyUrl, row.sourceUrl, row.document.url].includes(card.officialUrl) && row.document.status === 'INDEXED');
      check(`${label}: job card "${card.name}" is an indexed listing, title verbatim, link from the listing`, ok, JSON.stringify({ found: Boolean(row), url: card.officialUrl }));
      check(`${label}: job card "${card.name}" asserts no eligibility`, card.state === 'needs_verification' && card.contactPhone === null);
      continue;
    }
    const program = await prisma.program.findUnique({ where: { slug: card.slug }, include: { documents: true } });
    const doc = docs.find((d) => d.url === card.officialUrl);
    const linked = Boolean(program && doc && program.documents.some((pd) => pd.documentId === doc.id));
    const named = Boolean(program && doc?.chunks.some((c) => namedIn(`${c.headingPath ?? ''} ${c.content}`, program)));
    const quoted = Boolean(doc?.chunks.some((c) => c.content.replace(/\s+/g, ' ').includes(card.shortDescription.replace(/…$/, '').slice(0, 80))));
    check(`${label}: card "${card.name}" is linked, named in a cited document, and quoted from it`, linked && named && quoted, JSON.stringify({ linked, named, quoted, url: card.officialUrl }));
    check(`${label}: card "${card.name}" asserts no eligibility and no catalogue-only contact`, card.state === 'needs_verification' && card.contactPhone === null && card.nextSteps === null);
  }
}

(async () => {
  const ids: string[] = [];
  try {
    const a = await session('helper');
    ids.push(a.id);
    await a.say("I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.");
    await a.say('She has no reliable transportation and lives near Auburn.');
    const r = await a.say('She needs income as soon as possible.', true);
    check('A: results stage', r.stage === 'results', r.stage);
    check('A: verified answer with sources', r.sources.length > 0 && /confirmed by Golden Sierra staff/.test(r.message), r.message.slice(0, 200));
    await verify('A', r);
    check('A: GED gap stated, not invented', !/GED (prep|class|program)[^.]*\[\d+\]/i.test(r.message) && /didn't find indexed information on[^.]*GED/i.test(r.message), r.message.slice(-400));

    const c = await session('self');
    ids.push(c.id);
    const u = await c.say('I want to become a deep sea saturation diver. What programs pay for that?', true);
    check('C: unsupported need → no cards, no invented diving service', u.recommendations.length === 0 && !/saturation|diving/i.test(u.message.replace(/I searched[^.]*\./, '')), u.message);
    await verify('C', u);
  } finally {
    await prisma.chatSession.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
