/**
 * Strict indexed-knowledge answering, end to end against the live app, PostgreSQL and Qdrant.
 *
 * Every answer is checked against the actual PostgreSQL chunks it cites — not against the
 * model's self-reported citations. Synthetic documents are created through the product's own
 * upload endpoint and removed afterwards; existing knowledge (including Golden Sierra and
 * Orbit) is only read.
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/strict-rag.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { NO_ANSWER_TEXT, SMALL_TALK_TEXT, contentTerms, lexicalCoverage, splitSentences, stemSet } from '../../src/lib/rag/strict';
import { syntheticLines, syntheticPdf } from '../helpers/synthetic-pdf';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const RUN = randomUUID().slice(0, 6);
const OUT = path.resolve('test-artifacts/strict-rag');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${String(detail).slice(0, 600)}`}`); };
const info = (m: string) => console.log(`INFO  ${m}`);

let cookie = '';
type Diag = { mode: string; noAnswerReason: string | null; queryTerms: string[]; rewrittenQuery: string; filters: Record<string, unknown>; candidates: { chunkId: string; documentId: string; status: string; similarity: number | null; reason: string | null; title: string; text: string }[]; citationMap: { n: number; documentId: string; chunkIds: string[]; url: string | null }[]; unsupportedSentences: string[] };
type Result = { answer: string; analysis: { intent: string; rewrittenQuery: string }; citations: { id: number; url: string | null; title: string; documentId?: string; chunkIds?: string[] }[]; diagnostics: Diag; retrievedSources: { url: string }[] };

async function ask(message: string, opts: { sourceId?: string; profile?: object; history?: { role: 'user' | 'assistant'; content: string }[] } = {}): Promise<Result> {
  const res = await fetch(`${BASE}/api/admin/test-query`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message, ...opts }) });
  if (!res.ok) throw new Error(`test-query ${res.status} ${await res.text()}`);
  return (await res.json()) as Result;
}

/** Independent verification of an answer against PostgreSQL — no trust in the model's citations. */
async function verifyAgainstPostgres(r: Result): Promise<{ ok: boolean; why: string }> {
  if (r.citations.length === 0) return { ok: false, why: 'no citations' };
  const evidenceByDoc = new Map<string, string>();
  for (const c of r.citations) {
    if (!c.chunkIds?.length) return { ok: false, why: `citation ${c.id} lists no chunk ids` };
    const rows = await prisma.documentChunk.findMany({ where: { id: { in: c.chunkIds } }, include: { document: true } });
    if (rows.length !== c.chunkIds.length) return { ok: false, why: `citation ${c.id}: chunk ids not all in PostgreSQL` };
    for (const row of rows) {
      if (row.document.url !== c.url) return { ok: false, why: `citation ${c.id}: chunk belongs to ${row.document.url}, not ${c.url}` };
      if (row.document.status !== 'INDEXED') return { ok: false, why: `citation ${c.id}: document is ${row.document.status}` };
    }
    evidenceByDoc.set(String(c.id), rows.map((x) => x.content).join('\n'));
    // The chunk must also be a vector that really exists in Qdrant
    const pts = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: c.chunkIds } }] } });
    if (pts.count !== c.chunkIds.length) return { ok: false, why: `citation ${c.id}: ${pts.count}/${c.chunkIds.length} vectors in Qdrant` };
  }
  // Every cited sentence: its facts must be in the chunks it cites.
  for (const line of r.answer.split('\n')) {
    for (const sentence of splitSentences(line)) {
      const nums = [...sentence.matchAll(/\[(\d+(?:,\d+)*)\]/g)].flatMap((m) => m[1]!.split(','));
      if (nums.length === 0) continue;
      const evidence = nums.map((n) => evidenceByDoc.get(n) ?? '').join('\n');
      const clean = sentence.replace(/\[[\d,]+\]/g, '');
      const cov = lexicalCoverage(contentTerms(clean), stemSet(evidence));
      if (contentTerms(clean).length >= 2 && cov < 0.34) return { ok: false, why: `sentence not supported by its cited chunks (${Math.round(cov * 100)}%): ${clean.slice(0, 100)}` };
      for (const fig of clean.match(/\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d+\b/g) ?? []) {
        if (!evidence.replace(/\s/g, '').includes(fig.replace(/\s/g, ''))) return { ok: false, why: `figure ${fig} is not in the cited chunks` };
      }
    }
  }
  return { ok: true, why: '' };
}

const refused = (r: Result) => r.answer === NO_ANSWER_TEXT && r.citations.length === 0;

async function upload(name: string, lines: string[], fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', new File([syntheticPdf(lines, name)], `${name}.pdf`, { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(`${BASE}/api/admin/documents/upload`, { method: 'POST', body: form, headers: { cookie } });
  const body = (await res.json()) as { documentId?: string; error?: string };
  if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${body.error}`);
  return body.documentId!;
}

const pad = (lines: string[]) => [...lines, ...syntheticLines(`${RUN}-filler`, 6)];

(async () => {
  const baseline = { docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), sources: await prisma.knowledgeSource.count() };
  const points0 = (await getQdrant().getCollection(env.QDRANT_COLLECTION)).points_count;
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const created = { docs: [] as string[], sources: [] as string[] };
  const orbit = await prisma.knowledgeSource.findFirst({ where: { rootUrl: { contains: 'orbit.dotstark.tech' } } });
  const gs = await prisma.knowledgeSource.findFirst({ where: { rootUrl: 'https://goldensierra.com/' } });

  try {
    // ── fixtures: a dedicated source with two documents that must be combined for one answer ──
    const src = await prisma.knowledgeSource.create({ data: { name: `E2E strict source ${RUN}`, type: 'MANUAL' } });
    created.sources.push(src.id);
    const dA = await upload(`strict-a-${RUN}`, pad([
      `The Cobalt Heron Apprenticeship ${RUN} pays $23.40 per hour for the first year of training.`,
      `A new cohort of the Cobalt Heron Apprenticeship ${RUN} starts every March.`,
      `Applicants for the Cobalt Heron Apprenticeship ${RUN} must be at least eighteen years old.`,
    ]), { sourceId: src.id });
    const dB = await upload(`strict-b-${RUN}`, pad([
      `Orientation for the Cobalt Heron training programs ${RUN} is held on the first Monday of each month at the Larkspur Library.`,
      `Participants of the Cobalt Heron programs ${RUN} should bring photo identification and a resume to orientation.`,
    ]), { sourceId: src.id });
    const dC = await upload(`strict-c-${RUN}`, pad([`The quokka harvesting schedule ${RUN} runs from June to August and pays $11.75 per crate.`]));
    const dD = await upload(`strict-d-${RUN}`, pad([`The wombat relocation grant ${RUN} provides $4,800 toward fencing for approved ranchers.`]));
    const dE = await upload(`strict-e-${RUN}`, pad([`The platypus survey stipend ${RUN} is $310 per week for field volunteers.`]));
    const dF = await upload(`strict-f-${RUN}`, pad([`The employer-only Tern Hiring Credit ${RUN} reimburses $2,250 for each new welder an employer hires.`]), { audience: 'employer' });
    created.docs.push(dA, dB, dC, dD, dE, dF);
    info(`fixtures indexed: ${created.docs.length} documents, source ${src.id}`);

    // 1 ── factual question supported by indexed Golden Sierra documents ──
    const phone = await ask('What is the phone number for Golden Sierra Job Training Agency?');
    const v1 = await verifyAgainstPostgres(phone);
    check('1. Golden Sierra fact: answered with the real phone number', /746-7722/.test(phone.answer), phone.answer.slice(0, 200));
    check('1. …every citation is a goldensierra.com page, verified chunk-by-chunk in PostgreSQL + Qdrant', phone.citations.length > 0 && phone.citations.every((c) => c.url?.startsWith('https://goldensierra.com')) && v1.ok, v1.why);

    // 2 + 4 ── an indexed external website, and a question the classifier calls off-topic ──
    if (orbit) {
      const o = await ask('what is orbit');
      const v2 = await verifyAgainstPostgres(o);
      info(`"what is orbit" → intent=${o.analysis.intent}, mode=${o.diagnostics.mode}`);
      check('2/4. "what is orbit" is answered from the indexed Orbit site (not refused, not a Golden Sierra blurb)', /TradingView|Zerodha|automat/i.test(o.answer) && !/workforce|job search|scholarship/i.test(o.answer), o.answer.slice(0, 250));
      check('2/4. …all citations are orbit.dotstark.tech pages belonging to the Orbit source', o.citations.length > 0 && o.citations.every((c) => c.url?.includes('orbit.dotstark.tech')), JSON.stringify(o.citations.map((c) => c.url)));
      const docs = await prisma.document.findMany({ where: { id: { in: o.citations.map((c) => c.documentId!).filter(Boolean) } }, select: { sourceId: true } });
      check('2/4. …and PostgreSQL agrees those documents are the Orbit source\'s', docs.length > 0 && docs.every((d) => d.sourceId === orbit.id));
      check('2/4. …each cited sentence is supported by the chunks it cites (independent check)', v2.ok, v2.why);
      check('2/4. no promotional Golden Sierra content or follow-up questions in a lookup', !/golden sierra/i.test(o.answer) && !/\?\s*$/.test(o.answer.trim()));
    } else {
      info('Orbit is not indexed in this knowledge base — scenarios 2/4 skipped');
    }

    // 3 ── unsupported questions are refused with the fixed sentence ──
    for (const q of ['What is the capital of France?', 'How do vaccines work?', 'Who won the 2018 World Cup?', 'What is quantum computing?', 'Explain photosynthesis']) {
      const r = await ask(q);
      check(`3. unsupported "${q}" → the fixed no-answer sentence, no citations, no invented answer`, refused(r), r.answer.slice(0, 160));
      check(`3.   …with a stated reason: ${r.diagnostics.noAnswerReason}`, !!r.diagnostics.noAnswerReason);
    }

    // 5 ── multi-document consolidation ──
    const m = await ask(`How much does the Cobalt Heron Apprenticeship ${RUN} pay, and when is orientation for the Cobalt Heron programs ${RUN}?`);
    const v5 = await verifyAgainstPostgres(m);
    check('5. one answer combines both documents: wage ($23.40) and orientation (Larkspur Library)', /\$23\.40/.test(m.answer) && /Larkspur/i.test(m.answer), m.answer.slice(0, 300));
    check('5. …cited to two different documents', new Set(m.citations.map((c) => c.documentId)).size === 2 && [dA, dB].every((d) => m.citations.some((c) => c.documentId === d)), JSON.stringify(m.citations.map((c) => c.documentId)));
    check('5. …verified against PostgreSQL chunks', v5.ok, v5.why);

    // 6 ── follow-up using prior context ──
    const f = await ask('And how much does it pay?', { history: [
      { role: 'user', content: `What is the Cobalt Heron Apprenticeship ${RUN}?` },
      { role: 'assistant', content: `The Cobalt Heron Apprenticeship ${RUN} is a training program with a new cohort every March.` },
    ] });
    check('6. follow-up "how much does it pay?" is resolved from the prior turn and answered', /\$23\.40/.test(f.answer), `${f.analysis.rewrittenQuery} → ${f.answer.slice(0, 200)}`);
    check('6. …searched as the context-resolved question', /cobalt|heron|apprentice/i.test(f.diagnostics.rewrittenQuery), f.diagnostics.rewrittenQuery);

    // 7 ── deleted / stale indexed content ──
    const base7 = await ask(`How much does the quokka harvesting schedule ${RUN} pay per crate?`);
    check('7. (before) the fact is answered while indexed', /11\.75/.test(base7.answer), base7.answer);

    // (a) stale text: PostgreSQL chunk edited after the vector was written
    const cRow = (await prisma.documentChunk.findMany({ where: { documentId: dC } }))[0]!;
    await prisma.documentChunk.update({ where: { id: cRow.id }, data: { content: `${cRow.content} REVISED AFTER INDEXING` } });
    const staleC = await ask(`How much does the quokka harvesting schedule ${RUN} pay per crate?`);
    check('7a. stale vector text (PostgreSQL changed): rejected, and the stale figure is NOT served', refused(staleC) && !/11\.75/.test(staleC.answer) && staleC.diagnostics.candidates.some((c) => c.documentId === dC && c.status === 'rejected_stale_content'), JSON.stringify(staleC.diagnostics.candidates.filter((c) => c.documentId === dC).map((c) => c.status)));
    await prisma.documentChunk.update({ where: { id: cRow.id }, data: { content: cRow.content } });

    // (b) orphaned vector: chunk row deleted but the vector remains (crash / partial delete)
    const dRows = await prisma.documentChunk.findMany({ where: { documentId: dD } });
    await prisma.documentChunk.deleteMany({ where: { documentId: dD } });
    const orphan = await ask(`How much is the wombat relocation grant ${RUN}?`);
    check('7b. orphaned vector (no PostgreSQL chunk): rejected, nothing is answered from it', refused(orphan) && !/4,800/.test(orphan.answer) && orphan.diagnostics.candidates.some((c) => c.documentId === dD && c.status === 'rejected_not_in_postgres'), JSON.stringify(orphan.diagnostics.candidates.filter((c) => c.documentId === dD).map((c) => c.status)));
    check('7b. …and the Qdrant vectors for it do still exist (proving the PostgreSQL check, not Qdrant, stopped it)', (await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { value: dD } }] } })).count === dRows.length);

    // (c) properly archived through the product: vectors and chunks are removed
    const before7c = await ask(`What is the platypus survey stipend ${RUN} per week?`);
    const arch = await fetch(`${BASE}/api/admin/documents/${dE}`, { method: 'DELETE', headers: { cookie } });
    const after7c = await ask(`What is the platypus survey stipend ${RUN} per week?`);
    check('7c. archived document: answered before, refused after, and its vectors are gone', /\$310/.test(before7c.answer) && arch.ok && refused(after7c) && (await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { value: dE } }] } })).count === 0, `${before7c.answer.slice(0, 80)} | ${after7c.answer.slice(0, 80)}`);

    // 8 ── audience mismatch must not hide a public document ──
    if (orbit) {
      for (const audience of ['job_seeker', 'employer']) {
        const r = await ask('what is orbit', { profile: { audience } });
        check(`8. Orbit pages are labelled "agency", asked as ${audience}: still answered`, /TradingView|Zerodha|automat/i.test(r.answer) && r.citations.length > 0, r.answer.slice(0, 160));
      }
    }
    const emp = await ask(`How much does the Tern Hiring Credit ${RUN} reimburse?`, { profile: { audience: 'job_seeker' } });
    check('8. an employer-labelled document is still retrieved for a job-seeker profile (audience is a preference, not a filter)', /2,250/.test(emp.answer) && emp.diagnostics.candidates.some((c) => c.documentId === dF && c.status === 'used'), emp.answer.slice(0, 200));
    check('8. …and the diagnostics say audience is not a filter', /not a filter/.test(JSON.stringify(emp.diagnostics.filters)));

    // 9 ── source-specific retrieval, only when requested ──
    const inSrc = await ask(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`, { sourceId: src.id });
    check('9. restricted to its own source: answered', /\$23\.40/.test(inSrc.answer) && inSrc.citations.every((c) => [dA, dB].includes(c.documentId!)));
    const wrongSrc = gs ? await ask(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`, { sourceId: gs.id }) : null;
    if (wrongSrc) check('9. restricted to a different source: the fact is invisible', refused(wrongSrc), wrongSrc.answer.slice(0, 160));
    if (orbit) {
      const onlyThis = await ask('what is orbit', { sourceId: src.id });
      check('9. an Orbit question restricted to the E2E source: refused (no cross-source leakage)', refused(onlyThis), onlyThis.answer.slice(0, 160));
      const orbitOnly = await ask('what is orbit', { sourceId: orbit.id });
      check('9. …and answered when restricted to the Orbit source', orbitOnly.citations.length > 0 && orbitOnly.citations.every((c) => c.url?.includes('orbit.dotstark.tech')));
    }
    const unfiltered = await ask(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`);
    check('9. with no source filter, all permitted sources are searched', /\$23\.40/.test(unfiltered.answer) && unfiltered.diagnostics.filters.sourceIds === 'all permitted sources', JSON.stringify(unfiltered.diagnostics.filters));

    // 10 ── empty / unavailable knowledge ──
    const emptySrc = await prisma.knowledgeSource.create({ data: { name: `E2E empty source ${RUN}`, type: 'MANUAL' } });
    created.sources.push(emptySrc.id);
    const empty = await ask(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`, { sourceId: emptySrc.id });
    check('10. a source with nothing indexed: fixed no-answer, reason recorded, nothing invented', refused(empty) && empty.diagnostics.noAnswerReason === 'no_candidates' && empty.diagnostics.candidates.length === 0, `${empty.answer} ${empty.diagnostics.noAnswerReason}`);
    info('10. a wholly empty collection and an unreachable Qdrant are covered by tests/unit/strict-turn.test.ts (they would require emptying or stopping the shared stores)');

    // 11 ── calibration regressions on the real Golden Sierra knowledge base ──
    // Answerable questions whose wording shares few words with the page that answers them.
    const contact = await ask('How do I actually get in touch with someone?');
    const vContact = await verifyAgainstPostgres(contact);
    check('11. "get in touch with someone" is answered (not refused) from contact pages', !refused(contact) && contact.citations.length > 0, contact.answer.slice(0, 200));
    check('11. …including the agency\'s own contact page, every cited sentence verified in PostgreSQL', contact.citations.some((c) => c.url?.startsWith('https://goldensierra.com')) && vContact.ok, `${vContact.why} ${JSON.stringify(contact.citations.map((c) => c.url))}`);

    const elig = await ask('Do I qualify for a training scholarship if I make $40,000 a year?');
    const vElig = await verifyAgainstPostgres(elig);
    check('11. eligibility question: intent is eligibility', elig.analysis.intent === 'eligibility', elig.analysis.intent);
    check('11. …answered from the published criteria (English language learners / low-income), not refused', /low-income|English language/i.test(elig.answer) && !refused(elig), elig.answer.slice(0, 250));
    // A note that the documents are silent ("the sources do not specify an income threshold…$40,000") may echo the user's own
    // figure; what must never appear is a claim about it, an invented threshold, or a personal verdict.
    const claimsOnly = splitSentences(elig.answer.replace(/\n/g, ' ')).filter((x) => !/\b(sources?|documents?|pages?)\b[^.]{0,40}\b(do(es)? not|don.t)\b/i.test(x)).join(' ');
    check('11. …no invented income threshold, no personal eligibility verdict', !/\$40,000/.test(claimsOnly) && !/\$\d/.test(claimsOnly) && !/you (qualify|are eligible|do not qualify|don.t qualify)/i.test(elig.answer), elig.answer);
    check('11. …any statement of the documents\' silence is honest (they really publish no income threshold)', !/\bthreshold\b/i.test(elig.answer) || !(await prisma.documentChunk.count({ where: { content: { contains: 'income threshold', mode: 'insensitive' }, document: { status: 'INDEXED', url: { contains: 'goldensierra.com' } } } })), elig.answer);
    check('11. …verified against the cited chunks', vElig.ok, vElig.why);

    const amount = await ask('What is the exact dollar amount of the training scholarship?');
    check('11. "up to $1,000" is reported as "up to", never as an exact amount', /up to \$1,000/i.test(amount.answer) && !/exact(ly)? (amount )?(is |of )?\$1,000/i.test(amount.answer), amount.answer.slice(0, 250));

    const addr = await ask("Where is the job center's street address?");
    check('11. paraphrased wording ("street address") finds the glued scraped text ("California115 Ascot Drive")', /115 Ascot/.test(addr.answer) && (await verifyAgainstPostgres(addr)).ok, addr.answer.slice(0, 200));

    for (const q of ['What is the minimum wage in Oregon?', "How do I renew my driver's license?", 'What is the income limit for CalFresh?']) {
      const r = await ask(q);
      check(`11. near-domain but unsupported "${q}" → fixed no-answer sentence`, refused(r), r.answer.slice(0, 200));
    }

    // 12 ── routing: factual lookups vs the adaptive counselor flow (public session API) ──
    {
      const post = async (body: object) => (await (await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { sessionToken?: string; turn?: { stage: string; message: string; nextQuestion: string | null; sources: { url: string | null }[]; recommendations: unknown[]; knownFacts: { value?: string; label?: string }[] } };
      const started = await post({ mode: 'self' });
      const token = started.sessionToken!;
      const t1 = (await post({ sessionToken: token, message: "I'm unemployed and need help finding work" })).turn!;
      check('12. a personal statement continues through the counselor flow (asks its follow-up question)', !!t1.nextQuestion && t1.sources.length === 0, JSON.stringify({ stage: t1.stage, q: t1.nextQuestion }));
      const t2 = (await post({ sessionToken: token, message: 'What is the fax number?' })).turn!;
      check('12. a factual question mid-conversation is answered from the documents, with a source', /746-7733|771-2144/.test(t2.message) && t2.sources.length > 0 && t2.nextQuestion === null, t2.message.slice(0, 200));
      const t3 = (await post({ sessionToken: token, message: 'Placer County' })).turn!;
      check('12. …and the counselor then resumes: a bare reply is treated as an answer, not a lookup', t3.message !== NO_ANSWER_TEXT && (t3.nextQuestion !== null || t3.recommendations.length > 0 || t3.stage === 'results'), JSON.stringify({ stage: t3.stage, q: t3.nextQuestion, msg: t3.message.slice(0, 120) }));
      const t4 = (await post({ sessionToken: token, message: 'What is the capital of France?' })).turn!;
      check('12. an unsupported factual question mid-conversation is refused with the fixed sentence', t4.message === NO_ANSWER_TEXT && t4.sources.length === 0, t4.message.slice(0, 160));
      const t5 = (await post({ sessionToken: token, message: 'What programs can I apply for?' })).turn!;
      check('12. an open-ended personal question stays with the counselor (not a document lookup)', t5.message !== NO_ANSWER_TEXT, t5.message.slice(0, 160));
    }

    const hello = await ask('hello');
    check('conversation: a greeting gets a greeting, with no retrieval and no knowledge-base claim', hello.answer === SMALL_TALK_TEXT && hello.diagnostics.candidates.length === 0);

    // ── logging: /api/chat writes retrieval logs with chunk ids and scores ──
    const sess = (await (await fetch(`${BASE}/api/chat/session`, { method: 'POST' })).json()) as { sessionToken: string; sessionId: string };
    const chat = async (message: string) => (await (await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, sessionToken: sess.sessionToken, stream: false }) })).json()) as { answer: string; messageId: string; payload: { citations: { chunkIds?: string[] }[]; grounded: boolean; sources: unknown[] } };
    const yes = await chat(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`);
    const no = await chat('What is the capital of France?');
    const logs = await prisma.retrievalLog.findMany({ where: { sessionId: sess.sessionId }, orderBy: { createdAt: 'asc' } });
    const yesRes = (logs[0]?.results ?? []) as { chunkId: string; documentId: string; similarity: number | null; status: string; used: boolean }[];
    const usedIds = yesRes.filter((x) => x.used).map((x) => x.chunkId);
    const citedIds = yes.payload.citations.flatMap((c) => c.chunkIds ?? []);
    check('logging: a retrieval log row records chunk ids, document ids, similarity and verdict per candidate', logs.length === 2 && yesRes.length > 0 && yesRes.every((x) => x.chunkId && x.documentId && 'similarity' in x && x.status) && JSON.stringify(logs[0]!.filters).includes('PUBLIC'), JSON.stringify(logs[0]?.filters));
    check('logging: every citation in the response is a chunk the log shows was retrieved and used', citedIds.length > 0 && citedIds.every((id) => usedIds.includes(id)), `${citedIds} ⊄ ${usedIds}`);
    check('logging: the refused question logged no used chunks and is marked ungrounded', no.answer === NO_ANSWER_TEXT && ((logs[1]?.results ?? []) as { used: boolean }[]).every((x) => !x.used) && logs[1]?.grounded === false);
    check('/api/chat: refusal carries no sources, citations or promotional follow-ups', no.payload.sources.length === 0 && no.payload.citations.length === 0);
    await prisma.chatSession.delete({ where: { id: sess.sessionId } }).catch(() => undefined);

    // ── browser: the admin Testing Lab diagnostics and the admin chat ──
    const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource|negative time stamp/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`${BASE}/admin/testing`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill(EMAIL); await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click(); await page.locator('.sidebar').waitFor({ timeout: 25_000 });
    await page.goto(`${BASE}/admin/testing`, { waitUntil: 'networkidle' });

    const runLab = async (q: string) => {
      await page.locator('#testQuery').fill(q);
      await page.getByRole('button', { name: /Run test/ }).click();
      await page.locator('[data-testid=diagnostics]').waitFor({ timeout: 90_000 });
      await page.waitForTimeout(400);
    };
    await runLab(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`);
    const diag = await page.locator('[data-testid=diagnostics]').innerText();
    await page.screenshot({ path: `${OUT}/testing-lab-answered.png`, fullPage: true });
    check('Testing Lab shows the user query, detected intent, applied filters and relevance rules', diag.includes('Cobalt Heron Apprenticeship') && /Detected intent/i.test(diag) && /Applied filters/i.test(diag) && /PUBLIC/.test(diag) && /Relevance rules/i.test(diag));
    const rowsUsed = await page.locator('[data-testid=candidates] tr[data-status=used]').count();
    check('Testing Lab lists retrieved chunks with document title, chunk id, similarity and the verdict', rowsUsed > 0 && /chunk c[a-z0-9]+/i.test(diag) && /0\.\d{3}/.test(diag) && /used/.test(diag));
    check('Testing Lab shows the retrieved text and the citation → chunk mapping', (await page.locator('[data-testid=candidates] details').count()) > 0 && (await page.locator('[data-testid=citation-map] tbody tr').count()) > 0 && /\[1\]/.test(diag));
    check('Testing Lab: no "no-answer reason" block on an answered question', (await page.locator('[data-testid=no-answer-reason]').count()) === 0);

    await runLab('What is the capital of France?');
    const refusedUi = await page.locator('section.page.active').innerText();
    await page.screenshot({ path: `${OUT}/testing-lab-refused.png`, fullPage: true });
    check('Testing Lab: a refused question shows the no-answer reason and the fixed sentence', (await page.locator('[data-testid=no-answer-reason]').count()) === 1 && refusedUi.includes(NO_ANSWER_TEXT) && /unknown_term|no_relevant_chunk/.test(await page.locator('[data-testid=no-answer-reason]').innerText()));
    check('Testing Lab: …and the citation mapping says nothing is attributed', (await page.locator('[data-testid=citation-map-empty]').count()) === 1);

    await runLab(`How much does the wombat relocation grant ${RUN} give?`);
    check('Testing Lab: a rejected (stale/orphaned) vector is displayed with its rejection reason', (await page.locator('[data-testid=candidates] tr[data-status=rejected_not_in_postgres]').count()) > 0);

    const chatAsk = async (q: string, until: RegExp) => {
      // The admin chat is the Workforce Navigator: start a fresh conversation in "looking for myself" mode.
      await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
      await page.evaluate(() => sessionStorage.clear());
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('[data-testid=mode-self]').click();
      await page.waitForFunction(`!document.querySelector('#navInput')?.disabled`, null, { timeout: 30_000 });
      await page.locator('#navInput').fill(q);
      await page.locator('#navInput').press('Enter');
      await page.waitForFunction(`/${until.source}/i.test(document.querySelector('section.page.active')?.innerText ?? '')`, null, { timeout: 90_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      return page.locator('section.page.active').innerText();
    };
    const chatYes = await chatAsk(`How much does the Cobalt Heron Apprenticeship ${RUN} pay?`, /23\.40/);
    await page.screenshot({ path: `${OUT}/admin-chat-answered.png`, fullPage: true });
    check('Admin chat: supported question answered from the indexed document, with a source', /\$23\.40/.test(chatYes) && (await page.locator('[data-testid=citations] [data-testid=source-link]').count()) > 0);
    const chatNo = await chatAsk('What is the capital of France?', /couldn't find enough information/);
    await page.screenshot({ path: `${OUT}/admin-chat-refused.png`, fullPage: true });
    check('Admin chat: unsupported question → exactly the fixed sentence', chatNo.includes(NO_ANSWER_TEXT));
    check('Admin chat: a refusal is not padded with Golden Sierra marketing or a phone callout', !/not backed by indexed sources/i.test(chatNo) && (chatNo.match(/746-7722/g) ?? []).length <= 1 /* only the static footer */);
    check('no unexpected browser console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
  } catch (e) {
    fail++;
    console.log('FAIL  script error →', String(e).slice(0, 600));
  } finally {
    // cleanup of exactly what this run created, through the product's endpoints
    for (const id of created.docs) await fetch(`${BASE}/api/admin/documents/${id}?hard=true`, { method: 'DELETE', headers: { cookie } }).catch(() => undefined);
    for (const id of created.sources) await prisma.knowledgeSource.deleteMany({ where: { id } });
    await prisma.ingestionJob.deleteMany({ where: { params: { path: ['filename'], string_contains: `strict-` }, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
    const after = { docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), sources: await prisma.knowledgeSource.count() };
    const points1 = (await getQdrant().getCollection(env.QDRANT_COLLECTION)).points_count;
    check('cleanup restored documents, chunks, sources and the Qdrant point count exactly', JSON.stringify(after) === JSON.stringify(baseline) && points1 === points0, `${JSON.stringify(after)}/${points1} vs ${JSON.stringify(baseline)}/${points0}`);
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
