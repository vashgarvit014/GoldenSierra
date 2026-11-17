/**
 * Structured adaptive conversation flow, end to end against the live app, PostgreSQL and Qdrant.
 * Scenarios A–E over HTTP (/api/chat), then the same flow through the real admin chat in Chrome.
 * Every citation is verified against the PostgreSQL chunk and Qdrant vector it names. Read only:
 * the sessions it creates are deleted at the end; no knowledge records are touched.
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/guided-flow.ts
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { NO_ANSWER_TEXT, contentTerms, lexicalCoverage, splitSentences, stemSet } from '../../src/lib/rag/strict';
import { namedIn } from '../../src/lib/programs/link';
import type { AssistantPayload } from '../../src/types/chat';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const OUT = path.resolve('test-artifacts/guided-flow');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${String(detail).slice(0, 700)}`}`); };
const sessions: string[] = [];

type Turn = { answer: string; payload: AssistantPayload };
async function session() {
  const s = (await (await fetch(`${BASE}/api/chat/session`, { method: 'POST' })).json()) as { sessionId: string; sessionToken: string };
  sessions.push(s.sessionId);
  return async (message: string, forceResults = false): Promise<Turn> => {
    const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, sessionToken: s.sessionToken, stream: false, ...(forceResults ? { forceResults } : {}) }) });
    if (!res.ok) throw new Error(`/api/chat ${res.status} ${await res.text()}`);
    return (await res.json()) as Turn;
  };
}

/** Citation → chunk → document mapping, checked against PostgreSQL and Qdrant; every cited sentence against its chunks. */
async function verifyCitations(t: Turn): Promise<{ ok: boolean; why: string }> {
  const { citations } = t.payload;
  if (citations.length === 0) return { ok: false, why: 'no citations' };
  const evidence = new Map<number, string>();
  for (const c of citations) {
    if (!c.chunkIds?.length) return { ok: false, why: `citation ${c.id} has no chunk ids` };
    const rows = await prisma.documentChunk.findMany({ where: { id: { in: c.chunkIds } }, include: { document: true } });
    if (rows.length !== c.chunkIds.length) return { ok: false, why: `citation ${c.id}: chunk ids missing from PostgreSQL` };
    for (const r of rows) {
      if (r.documentId !== c.documentId) return { ok: false, why: `citation ${c.id}: chunk ${r.id} belongs to ${r.documentId}, not ${c.documentId}` };
      if (r.document.url !== c.url) return { ok: false, why: `citation ${c.id}: url ${c.url} ≠ ${r.document.url}` };
      if (r.document.status !== 'INDEXED' || r.document.accessLevel !== 'PUBLIC') return { ok: false, why: `citation ${c.id}: document ${r.document.status}/${r.document.accessLevel}` };
    }
    const pts = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: c.chunkIds } }] } });
    if (pts.count !== c.chunkIds.length) return { ok: false, why: `citation ${c.id}: ${pts.count}/${c.chunkIds.length} vectors in Qdrant` };
    evidence.set(c.id, rows.map((r) => `${r.document.title} ${r.content}`).join('\n'));
  }
  for (const line of t.answer.split('\n')) {
    for (const sentence of splitSentences(line)) {
      const nums = [...sentence.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)].flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim())));
      if (!nums.length) continue;
      for (const n of nums) if (!evidence.has(n)) return { ok: false, why: `[${n}] is not a returned citation` };
      const text = nums.map((n) => evidence.get(n)!).join('\n');
      const clean = sentence.replace(/\[[\d,\s]+\]/g, '');
      const terms = contentTerms(clean);
      const cov = lexicalCoverage(terms, stemSet(text));
      if (terms.length >= 2 && cov < 0.34) return { ok: false, why: `unsupported by its chunks (${Math.round(cov * 100)}%): ${clean.slice(0, 120)}` };
      for (const fig of clean.match(/\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d+\b/g) ?? []) {
        if (!text.replace(/\s/g, '').includes(fig.replace(/\s/g, ''))) return { ok: false, why: `figure ${fig} not in cited chunks` };
      }
    }
  }
  return { ok: true, why: '' };
}

/** Recommendation cards may only name a program that a cited chunk names, quoting that chunk. */
async function verifyCards(t: Turn): Promise<{ ok: boolean; why: string }> {
  const cited = t.payload.citations.flatMap((c) => c.chunkIds ?? []);
  const rows = await prisma.documentChunk.findMany({ where: { id: { in: cited } }, include: { document: { select: { title: true } } } });
  const text = rows.map((r) => `${r.document.title} ${r.content}`).join('\n').replace(/\s+/g, ' ').toLowerCase();
  for (const r of t.payload.recommendations) {
    // The card's program must be linked (ProgramDocument) to a cited chunk's document, and that chunk must name it.
    const program = await prisma.program.findUnique({ where: { slug: r.slug ?? '' }, include: { documents: true } });
    if (!program) return { ok: false, why: `card "${r.name}" is not a catalogue program` };
    const linked = rows.filter((row) => program.documents.some((d) => d.documentId === row.documentId));
    if (!linked.some((row) => namedIn(`${row.headingPath ?? ''} ${row.content}`, program))) return { ok: false, why: `card "${r.name}" is not named in a cited chunk of a linked document` };
    if (!text.includes(r.shortDescription.replace(/…$/, '').replace(/\s+/g, ' ').toLowerCase().slice(0, 80))) return { ok: false, why: `card "${r.name}" description is not quoted from a cited chunk` };
    if (!r.requiresVerification) return { ok: false, why: `card "${r.name}" does not defer eligibility to staff` };
  }
  return { ok: true, why: '' };
}

const CATALOGUE = async () => (await prisma.program.findMany({ select: { name: true } })).map((p) => p.name.replace(/\s*\(.*?\)/, '').replace(/s$/, ''));
const FOSTER = "I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.";
const questions = (s: string) => (s.match(/\?/g) ?? []).length;

(async () => {
  try {
    const catalogue = await CATALOGUE();

    // ── Scenario A: personal guidance ──
    const a = await session();
    const a1 = await a(FOSTER);
    const f1 = a1.payload.flow!;
    check('A1: personal message → guided flow (CLARIFYING or DISCOVERING_NEEDS)', f1.route === 'personal' && ['CLARIFYING', 'DISCOVERING_NEEDS'].includes(f1.stage), JSON.stringify(f1));
    check('A1: exactly one question, with 2–4 quick replies', questions(a1.answer) === 1 && f1.quickReplies.length >= 2 && f1.quickReplies.length <= 4, a1.answer);
    check('A1: first message extracted (helper mode, age, healthcare, GED, foster youth) — nothing re-asked', /Helping someone else/.test(f1.knownFacts.who ?? '') && /19/.test(f1.knownFacts.age ?? '') && /Healthcare/.test(f1.knownFacts.careerInterest ?? '') && /GED/.test(f1.knownFacts.education ?? '') && /foster/i.test(f1.knownFacts.situation ?? '') && !/how old|what kind of work|GED\?/i.test(f1.question ?? ''), JSON.stringify(f1));
    check('A1: no program names, figures or citations on a clarifying turn', a1.payload.citations.length === 0 && !catalogue.some((n) => a1.answer.toLowerCase().includes(n.toLowerCase())) && !/\$\d/.test(a1.answer), a1.answer);
    check('A1: no "Assuming…" box content and no service claims', !/assum/i.test(a1.answer) && !/\b(offers|provides|eligible)\b/i.test(a1.answer.split('\n\n')[0]!), a1.answer);

    const a2 = await a('She has no reliable transportation and lives near Auburn.');
    const f2 = a2.payload.flow!;
    check('A2: remembers earlier context and adds the new facts', /Auburn/.test(f2.knownFacts.geography ?? '') && /no transport/i.test(f2.knownFacts.geography ?? '') && /Healthcare/.test(f2.knownFacts.careerInterest ?? '') && /19/.test(f2.knownFacts.age ?? ''), JSON.stringify(f2.knownFacts));
    check('A2: next step adjusts — no transport/location question, and never the identical question again', !/transport|which county|get to/i.test(f2.question ?? '') && f2.question !== f1.question, `${f1.question} → ${f2.question}`);
    check('A2: still one question at most', questions(a2.answer.split('Still unknown')[0]!) <= 1 || f2.stage === 'SHOWING_RESULTS', a2.answer);

    const a3 = await a('She needs income urgently.');
    const f3 = a3.payload.flow!;
    check('A3: results shown (SHOWING_RESULTS or FOLLOW_UP)', ['SHOWING_RESULTS', 'FOLLOW_UP'].includes(f3.stage), `${f3.stage}: ${a3.answer.slice(0, 300)}`);
    const v3 = await verifyCitations(a3);
    check('A3: recommendations are cited, and every citation maps to its PostgreSQL chunk, document and Qdrant vector', v3.ok, v3.why);
    const c3 = await verifyCards(a3);
    check('A3: cards only for programs linked to a cited document and named in the cited chunk, quoted verbatim', c3.ok, c3.why);
    check('A3: eligibility uncertainty kept inside the answer; urgency remembered', /confirmed by Golden Sierra staff/.test(a3.answer) && /income/i.test(f3.knownFacts.incomeUrgency ?? ''), a3.answer.slice(-400));
    check('A3: no fabricated combined GED + healthcare program', !/(GED|diploma)[^.\n]*healthcare[^.\n]*program|healthcare[^.\n]*(GED|diploma)[^.\n]*program/i.test(a3.answer.replace(/I searched[^\n]*\n/, '').replace(/I didn't find[^\n]*/, '')), a3.answer);

    // ── Scenario D: correction ──
    const d1 = await a('Actually, she does have a car now.');
    const fd = d1.payload.flow!;
    check('D: correction updates context (transport), keeps everything else', fd.corrections.includes('transportation') && /vehicle/i.test(fd.knownFacts.geography ?? '') && /Auburn/.test(fd.knownFacts.geography ?? '') && /Healthcare/.test(fd.knownFacts.careerInterest ?? ''), JSON.stringify(fd));
    check('D: recommendations re-run as FOLLOW_UP and acknowledge the update', fd.stage === 'FOLLOW_UP' && /updated/i.test(d1.answer.split('\n')[0]!), `${fd.stage} ${d1.answer.slice(0, 160)}`);
    const vd = await verifyCitations(d1);
    check('D: updated recommendations are cited and verified against PostgreSQL/Qdrant', vd.ok || d1.answer.includes(NO_ANSWER_TEXT), vd.why);
    const stored = await prisma.chatSession.findFirst({ where: { id: sessions[0] }, select: { profile: true } });
    const flowRow = (stored?.profile as { flow?: { stage: string; context: { transportation?: string } } }).flow;
    check('D: conversation state persisted with the session (stage + corrected context)', flowRow?.stage === 'FOLLOW_UP' && flowRow.context.transportation === 'own_vehicle', JSON.stringify(flowRow));

    // ── Scenario B: direct factual lookup (fresh session, and mid-conversation) ──
    const b = await session();
    const b1 = await b('What is Orbit?');
    const vb = await verifyCitations(b1);
    check('B: "What is Orbit?" → direct cited answer, no questionnaire', b1.payload.flow?.route === 'factual' && b1.payload.flow.question === null && b1.payload.flow.quickReplies.length === 0 && /orbit/i.test(b1.answer) && vb.ok, `${vb.why} ${b1.answer.slice(0, 200)}`);
    check('B: citations point at Orbit documents', b1.payload.citations.every((c) => /orbit/i.test(`${c.title} ${c.url}`)), JSON.stringify(b1.payload.citations.map((c) => c.url)));
    const bMid = await a('What is Orbit?');
    check('B: a factual question mid-conversation is answered directly and leaves the guided state intact', bMid.payload.flow?.route === 'factual' && bMid.payload.flow.stage === 'FOLLOW_UP' && /Healthcare/.test(bMid.payload.flow.knownFacts.careerInterest ?? '') && bMid.payload.citations.length > 0, JSON.stringify(bMid.payload.flow));

    // ── Scenario C: unsupported ──
    const c = await session();
    const c1 = await c('What is the capital of France?');
    check('C: unsupported factual question → exactly the fixed no-answer sentence', c1.answer === NO_ANSWER_TEXT && c1.payload.citations.length === 0);
    const c2 = await c("I'm looking for deep sea saturation diving certification training.", true);
    const vc2 = c2.payload.citations.length ? await verifyCitations(c2) : { ok: true, why: '' };
    check('C: unsupported personal need → no invented diving service; any remaining text is cited and verified', !/\[\d[^\]]*\][^\n]*/.test(c2.answer.split('\n').filter((l) => /diving|saturation/i.test(l)).join('\n')) && vc2.ok, `${vc2.why} ${c2.answer.slice(0, 400)}`);
    check('C: the knowledge limitation is stated', c2.answer.includes(NO_ANSWER_TEXT) || /didn't find indexed information on (saturation|deep sea|.*diving)/i.test(c2.answer), c2.answer.slice(0, 400));

    // ── Scenario E: early results ──
    const e = await session();
    const e1 = await e("I'm unemployed and want to get into healthcare.");
    check('E1: clarifying with the results option offered', e1.payload.flow!.canShowResults && ['CLARIFYING', 'DISCOVERING_NEEDS'].includes(e1.payload.flow!.stage), JSON.stringify(e1.payload.flow));
    const e2 = await e('Show me the options you have so far', true);
    const ve = await verifyCitations(e2);
    check('E2: early results are evidence-supported (citations verified)', ['SHOWING_RESULTS', 'FOLLOW_UP'].includes(e2.payload.flow!.stage) && ve.ok, `${ve.why} ${e2.answer.slice(0, 300)}`);
    check('E2: remaining uncertainties are identified', e2.payload.flow!.uncertainties.length > 0 && /Still unknown:/.test(e2.answer), JSON.stringify(e2.payload.flow!.uncertainties));
    const ctxE = (await prisma.chatSession.findFirst({ where: { id: sessions[3] }, select: { profile: true } }))?.profile as { flow?: { context: Record<string, unknown> } };
    check('isolation: each session keeps only its own facts', !JSON.stringify(ctxE?.flow?.context ?? {}).match(/foster|auburn/i), JSON.stringify(ctxE?.flow?.context));

    // The admin chat's browser checks (mode selection, quick replies, sidebar, narrowing, results, mobile)
    // live in tests/e2e/navigator.ts since the Workforce Navigator replaced the chat presentation.
  } catch (err) {
    fail++;
    console.log('FAIL  script error →', String(err).slice(0, 700));
  } finally {
    await prisma.chatSession.deleteMany({ where: { id: { in: sessions } } }).catch(() => undefined);
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
