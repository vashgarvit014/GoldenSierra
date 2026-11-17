/**
 * Workforce Navigator end to end, against the running app (real PostgreSQL, Qdrant and Mercury-3).
 *
 * HTTP: both modes, role-based matching (exact / related / transferable), job cards traced to their
 * listing, document, chunks and Qdrant points, corrections, unsupported roles, direct factual questions.
 * Browser (Chrome): mode selection, header, bubbles, quick replies, See Results, sidebar facts and real
 * narrowing counts, grouped results with expandable details, mobile drawer. Screenshots go to
 * test-artifacts/navigator/.
 *
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/navigator.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import type { AssistantPayload } from '../../src/types/chat';
import type { JobMatch } from '../../src/types/navigator';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const OUT = 'test-artifacts/navigator';
fs.mkdirSync(OUT, { recursive: true });

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail.slice(0, 400)}`}`);
};
const sessions: string[] = [];
type Turn = { answer: string; payload: AssistantPayload };

async function session(mode: 'self' | 'helper') {
  const s = (await (await fetch(`${BASE}/api/chat/session`, { method: 'POST' })).json()) as { sessionId: string; sessionToken: string };
  sessions.push(s.sessionId);
  return async (message: string, forceResults = false): Promise<Turn> => {
    const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, sessionToken: s.sessionToken, mode, forceResults, stream: false }) });
    if (!res.ok) throw new Error(`chat ${res.status} ${await res.text()}`);
    return (await res.json()) as Turn;
  };
}

/** "See Results"; if one optional qualification question comes back first, answer "Show results anyway". */
async function results(say: (m: string, f?: boolean) => Promise<Turn>): Promise<Turn> {
  const t = await say('Show me the options you have so far', true);
  return t.payload.flow?.stage === 'CLARIFYING' || t.payload.flow?.stage === 'DISCOVERING_NEEDS' ? say('Show results anyway') : t;
}
const jobsOf = (t: Turn): JobMatch[] => [...(t.payload.navigator?.results?.bestJobs ?? []), ...(t.payload.navigator?.results?.relatedJobs ?? [])];
const questions = (s: string) => (s.match(/\?/g) ?? []).length;

/** Every job card: its listing row exists, each displayed field is in the listing's segment, the segment is in the document, the cited chunks contain the title and have Qdrant points. */
async function verifyJobs(jobs: JobMatch[]): Promise<{ ok: boolean; why: string }> {
  const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  for (const j of jobs) {
    const row = await prisma.jobListing.findUnique({ where: { id: j.id }, include: { document: true } });
    if (!row) return { ok: false, why: `no listing row for ${j.title}` };
    if (row.document.status !== 'INDEXED' || row.document.accessLevel !== 'PUBLIC') return { ok: false, why: `${j.title}: document not indexed/public` };
    if (!squash(row.document.content).includes(squash(row.segment))) return { ok: false, why: `${j.title}: segment not in document` };
    for (const [k, v] of Object.entries({ title: j.title, employer: j.employer, county: j.county, salary: j.salary, summary: j.summary, deadline: j.deadline })) {
      if (v && !squash(row.segment).includes(squash(v))) return { ok: false, why: `${j.title}: ${k} "${v}" not in its own listing` };
    }
    for (const r of j.requirements) {
      if (!squash(row.segment).includes(squash(r.text))) return { ok: false, why: `${j.title}: requirement "${r.text}" not in listing` };
      // Each requirement cites indexed chunks of the same document.
      const rc = await prisma.documentChunk.findMany({ where: { id: { in: r.source.chunkIds } } });
      if (!rc.length || rc.some((c) => c.documentId !== row.documentId)) return { ok: false, why: `${j.title}: requirement "${r.text}" has no source chunk` };
    }
    if (!j.source.chunkIds.length) return { ok: false, why: `${j.title}: no cited chunk` };
    const chunks = await prisma.documentChunk.findMany({ where: { id: { in: j.source.chunkIds } } });
    if (chunks.length !== j.source.chunkIds.length || !chunks.every((c) => c.documentId === row.documentId && squash(c.content).includes(squash(j.title)))) return { ok: false, why: `${j.title}: cited chunk mismatch` };
    const points = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: j.source.chunkIds } }] } });
    if (points.count !== j.source.chunkIds.length) return { ok: false, why: `${j.title}: ${points.count}/${j.source.chunkIds.length} chunks in Qdrant` };
  }
  return { ok: true, why: '' };
}

/** Text citations map to real, indexed chunks (same check as the guided-flow suite, condensed). */
async function verifyCitations(t: Turn): Promise<{ ok: boolean; why: string }> {
  for (const c of t.payload.citations) {
    const rows = await prisma.documentChunk.findMany({ where: { id: { in: c.chunkIds ?? [] } }, include: { document: true } });
    if (!rows.length || rows.some((r) => r.document.status !== 'INDEXED' || r.document.url !== c.url)) return { ok: false, why: `citation [${c.id}] does not map to its chunks` };
  }
  return { ok: true, why: '' };
}

(async () => {
  try {
    // ── A: helping someone ──
    const a = await session('helper');
    const a1 = await a("I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.");
    const f1 = a1.payload.flow!;
    check('A1: third person, one question, 2–4 quick replies', questions(a1.answer) === 1 && !/\byou\b/i.test(a1.answer.replace(/\byou'?re helping\b/i, '')) && f1.quickReplies.length >= 2 && f1.quickReplies.length <= 4, a1.answer);
    check('A1: context extracted (helper, 19, healthcare, GED, foster youth)', f1.knownFacts.who === 'Helping someone else' && /19/.test(f1.knownFacts.age ?? '') && /Healthcare/.test(f1.knownFacts.careerInterest ?? '') && /GED/i.test(f1.knownFacts.education ?? '') && /foster/i.test(f1.knownFacts.situation ?? ''), JSON.stringify(f1.knownFacts));
    const n1 = a1.payload.navigator?.narrowing;
    const totalListings = await prisma.jobListing.count();
    check('A1: narrowing counts are real (listing total equals the JobListing table)', n1?.listings.total === totalListings && n1.programs.total === (await prisma.program.count({ where: { status: 'ACTIVE' } })), JSON.stringify(n1));
    const a2 = await a("No reliable transportation. She's staying near Auburn.");
    check('A2: context updated; the next question is a different one', /Auburn/.test(a2.payload.flow!.knownFacts.geography ?? '') && a2.payload.flow!.question !== f1.question, JSON.stringify(a2.payload.flow));
    const a3 = a2.payload.flow!.stage === 'SHOWING_RESULTS' ? a2 : await a('She needs income as soon as possible.');
    const ja = jobsOf(a3);
    check('A3: results with role-based job matches (healthcare field)', ['SHOWING_RESULTS', 'FOLLOW_UP'].includes(a3.payload.flow!.stage) && ja.some((j) => /caregiver/i.test(j.title)), JSON.stringify(ja.map((j) => `${j.kind}:${j.title}`)));
    const va = await verifyJobs(ja);
    check('A3: every job card traces to its listing, document, chunks and Qdrant points', va.ok, va.why);
    const vca = await verifyCitations(a3);
    check('A3: text citations map to indexed chunks', vca.ok, vca.why);
    check('A3: no invented GED or healthcare-training program; gaps stated', !/GED (prep|class|program|course)[^.]*\[\d+\]/i.test(a3.answer) && /didn't find indexed information on[^.]*GED|couldn't find enough information/i.test(a3.answer), a3.answer);
    check('A3: no eligibility claimed', !/\b(she|they) (is|are) eligible\b|\bqualifies\b/i.test(a3.answer), a3.answer);

    // ── B: looking for myself, transferable experience ──
    const b = await session('self');
    const b1 = await b('I have experience installing solar panels and want a better job.');
    const fb = b1.payload.flow!;
    check('B1: second person; experience recognised as a role', /\byou(r)?\b/i.test(b1.answer) && /Solar/i.test(fb.knownFacts.experience ?? ''), `${b1.answer} ${JSON.stringify(fb.knownFacts)}`);
    const b2 = await results(b);
    const jb = jobsOf(b2);
    check('B2: related roles found without the word "solar" in the listings (electrician / lighting technician)', jb.some((j) => j.kind === 'related' && /electrician|lighting/i.test(j.title)) && jb.every((j) => !/solar/i.test(j.title)), JSON.stringify(jb.map((j) => `${j.kind}:${j.title}`)));
    check('B2: related roles are not presented as role matches', (b2.payload.navigator?.results?.bestJobs ?? []).every((j) => j.kind === 'exact'), '');
    check('B2: role search shows the widening', (b2.payload.navigator?.results?.roleSearch.related ?? []).some((r) => /electrician/i.test(r)), JSON.stringify(b2.payload.navigator?.results?.roleSearch));
    const vb = await verifyJobs(jb);
    check('B2: job cards verified against PostgreSQL and Qdrant', vb.ok, vb.why);

    // ── C: no job title, only duties ──
    const c = await session('self');
    await c('For five years I helped elderly people at home with bathing, dressing and meal preparation.');
    const c2 = await results(c);
    const jc = jobsOf(c2);
    check('C: duties without a title → caregiver role recognised and matched', (c2.payload.navigator?.results?.bestJobs ?? []).some((j) => /caregiver/i.test(j.title)), JSON.stringify(jc.map((j) => `${j.kind}:${j.title}`)));
    const vc = await verifyJobs(jc);
    check('C: matched listings verified, none fabricated', vc.ok, vc.why);

    // ── D: direct factual query ──
    const d = await session('self');
    // (The Orbit documents were archived in the knowledge base on 2026-11-17; a still-indexed topic is used.)
    const d1 = await d('What is the Elevate program?');
    const vd = await verifyCitations(d1);
    check('D: "What is the Elevate program?" → direct cited answer, no questionnaire', d1.payload.flow?.route === 'factual' && !d1.payload.flow.quickReplies.length && /elevate/i.test(d1.answer) && d1.payload.citations.length > 0 && vd.ok, d1.answer.slice(0, 200));

    // ── E: unsupported role ──
    const e = await session('self');
    await e('I want to work as a deep sea saturation diver.');
    const e2 = await results(e);
    check('E: no invented listings; the gap is explained', jobsOf(e2).length === 0 && /none related|couldn't find enough information|didn't find indexed information/i.test(e2.answer) && !/saturation diver[^.]*\[\d+\]/i.test(e2.answer), e2.answer);

    // ── F: correction ──
    const f = await session('self');
    await f('I worked as a bookkeeper doing QuickBooks and invoices, and I live in Roseville.');
    const fr = await results(f);
    const before = jobsOf(fr).map((j) => j.title);
    const fc = await f('Actually I want to move into healthcare work instead, and I moved to Placerville.');
    const after = jobsOf(fc).map((j) => j.title);
    check('F: correction updates context (career and location) and re-runs matching', fc.payload.flow!.stage === 'FOLLOW_UP' && /Placerville/i.test(fc.payload.flow!.knownFacts.geography ?? '') && /health/i.test(fc.payload.flow!.knownFacts.careerInterest ?? ''), JSON.stringify(fc.payload.flow));
    check('F: results change with the new preference (healthcare listing appears)', after.some((t) => /caregiver/i.test(t)) && JSON.stringify(after) !== JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    // ── G: browser ──
    const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
    const ctxDesk = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctxDesk.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource|negative time stamp/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
    if (await page.locator('#email').count()) {
      await page.locator('#email').fill(EMAIL);
      await page.locator('#password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.locator('.sidebar').waitFor({ timeout: 25_000 });
      await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
    }
    await page.evaluate(() => sessionStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-testid=mode-selection]').waitFor();
    await page.screenshot({ path: `${OUT}/1-mode-selection.png` });
    check('G: mode selection offers both modes', (await page.locator('[data-testid=mode-helper]').count()) === 1 && (await page.locator('[data-testid=mode-self]').count()) === 1);

    const assistants = (p: Page) => p.locator('[data-testid=assistant-message]').count();
    const say = async (p: Page, text: string) => {
      const n = await assistants(p);
      await p.locator('#navInput').fill(text);
      await p.locator('#navInput').press('Enter');
      await p.waitForFunction((k) => document.querySelectorAll('[data-testid=assistant-message]').length > k, n, { timeout: 150_000 });
      await p.waitForTimeout(400);
    };
    await page.locator('[data-testid=mode-helper]').click();
    await page.locator('[data-testid=opener]').waitFor();
    check('G: header shows mode, Start over and Leave', /Helping someone/.test(await page.locator('[data-testid=mode-pill]').innerText()) && (await page.locator('[data-testid=start-over]').count()) === 1 && (await page.getByRole('link', { name: 'Leave' }).count()) === 1);
    await say(page, "I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.");
    await page.screenshot({ path: `${OUT}/2-clarifying.png` });
    const qr = await page.locator('[data-testid=quick-reply]').count();
    check('G: one question with 2–4 quick-reply buttons and a See Results button', qr >= 2 && qr <= 4 && (await page.locator('[data-testid=show-results]').count()) === 1, `${qr}`);
    const side1 = await page.locator('[data-testid=known-facts]').innerText();
    check('G: sidebar "What I know so far" shows the extracted facts', /WHAT I KNOW SO FAR/i.test(side1) && /Healthcare/.test(side1) && /19/.test(side1), side1);
    check('G: narrowing shows real counts', new RegExp(`of ${totalListings}`).test(await page.locator('[data-testid=narrow-listings]').innerText()), await page.locator('[data-testid=narrowing]').innerText());
    const userBg = await page.locator('[data-testid=user-message] div').last().evaluate((el) => getComputedStyle(el).backgroundColor);
    check('G: user bubble is gold, right-aligned', /255, 196, 37/.test(userBg) && (await page.locator('[data-testid=user-message]').first().evaluate((el) => getComputedStyle(el).flexDirection)) === 'row-reverse', userBg);
    // Click a quick reply (functional), then ask for results.
    await page.locator('[data-testid=quick-reply]').first().click();
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid=assistant-message]').length > k, 1, { timeout: 150_000 });
    await page.waitForTimeout(400);
    check('G: quick reply sends its answer', (await page.locator('[data-testid=user-message]').count()) === 2);
    if (await page.locator('[data-testid=show-results]').count()) {
      const n = await assistants(page);
      await page.locator('[data-testid=show-results]').click();
      await page.waitForFunction((k) => document.querySelectorAll('[data-testid=assistant-message]').length > k, n, { timeout: 150_000 });
    } else await say(page, 'She needs income as soon as possible.');
    await page.locator('[data-testid=results]').last().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${OUT}/3-results.png`, fullPage: true });
    await page.locator('[data-testid=results]').last().screenshot({ path: `${OUT}/3b-results-cards.png` });
    const cards = await page.locator('[data-testid=job-card]').count();
    check('G: results render in reference groups with job cards', cards > 0 && (await page.locator('[data-testid=group-best], [data-testid=group-related]').count()) > 0, `${cards} cards`);
    await page.locator('[data-testid=job-card] button[aria-expanded]').first().click();
    await page.locator('[data-testid=job-details]').first().waitFor();
    await page.locator('[data-testid=job-card]').first().screenshot({ path: `${OUT}/4-card-expanded.png` });
    const det = await page.locator('[data-testid=job-details]').first().innerText();
    check('G: expanded card shows requirements, source and the not-a-confirmed-opening caveat', /Source/i.test(det) && /not a confirmed current opening/i.test(det), det);
    check('G: no "Assuming from what you\'ve told me" box', !/Assuming from what you/i.test(await page.locator('[data-testid=navigator]').innerText()));
    check('G: no unexpected console errors', errors.length === 0, errors.join(' | '));

    // Mobile: sidebar becomes a drawer; no horizontal overflow.
    const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctxDesk.storageState() })).newPage();
    await mobile.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
    await mobile.locator('[data-testid=mode-self]').waitFor();
    await mobile.screenshot({ path: `${OUT}/5-mobile-modes.png` });
    await mobile.locator('[data-testid=mode-self]').click();
    await say(mobile, 'I have experience installing solar panels and want a better job.');
    const overflow = await mobile.evaluate(() => document.querySelector('[data-testid=navigator]')!.scrollWidth - document.querySelector('[data-testid=navigator]')!.clientWidth);
    const sideHidden = await mobile.locator('aside[aria-label="What I know so far"]').evaluate((el) => getComputedStyle(el).display === 'none');
    await mobile.locator('[data-testid=side-toggle]').click();
    const sideShown = await mobile.locator('aside[aria-label="What I know so far"]').evaluate((el) => getComputedStyle(el).display !== 'none');
    await mobile.screenshot({ path: `${OUT}/6-mobile-drawer.png` });
    check('G: mobile — no horizontal overflow; sidebar collapses into a drawer', overflow <= 1 && sideHidden && sideShown, `overflow=${overflow} hidden=${sideHidden} shown=${sideShown}`);
    await browser.close();
  } catch (err) {
    check('suite ran to completion', false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await prisma.chatSession.deleteMany({ where: { id: { in: sessions } } });
    await prisma.$disconnect();
  }
  const failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(checks, null, 2));
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
