/**
 * Qualification-aware matching end to end, on the REAL indexed job listings (no synthetic data here).
 * Every PASS below compares the published requirements of actual JobListing rows with what was said
 * in the conversation. Synthetic certificate/degree cases are in tests/unit/qualification.test.ts.
 *
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/qualification.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import type { AssistantPayload } from '../../src/types/chat';
import type { JobMatch } from '../../src/types/navigator';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const OUT = 'test-artifacts/qualification';
fs.mkdirSync(OUT, { recursive: true });
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail.slice(0, 500)}`}`);
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
const R = (t: Turn) => t.payload.navigator?.results;
const all = (t: Turn): JobMatch[] => [...(R(t)?.bestJobs ?? []), ...(R(t)?.relatedJobs ?? []), ...(R(t)?.gapJobs ?? [])];
const find = (t: Turn, title: RegExp) => all(t).find((j) => title.test(j.title));
const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');

/** Requirements are verbatim in the listing's own segment and cite chunks of that document present in Qdrant. */
async function verifyRequirements(jobs: JobMatch[]): Promise<{ ok: boolean; why: string }> {
  for (const j of jobs) {
    const row = await prisma.jobListing.findUnique({ where: { id: j.id } });
    if (!row) return { ok: false, why: `no row ${j.title}` };
    for (const r of j.requirements) {
      if (!squash(row.segment).includes(squash(r.text))) return { ok: false, why: `${j.title}: "${r.text}" not in its listing` };
      const chunks = await prisma.documentChunk.findMany({ where: { id: { in: r.source.chunkIds } } });
      if (!chunks.length || chunks.some((c) => c.documentId !== row.documentId)) return { ok: false, why: `${j.title}: "${r.text}" source chunks wrong` };
      const n = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: r.source.chunkIds } }] } });
      if (n.count !== r.source.chunkIds.length) return { ok: false, why: `${j.title}: chunks missing from Qdrant` };
    }
  }
  return { ok: true, why: '' };
}

(async () => {
  try {
    // 1. Degree-bearing role (Accounting Assistant: "Relevant college degree, or equivalent combination…"), education unknown.
    const it = await session('self');
    const it1 = await it('I want to work as an accounting assistant doing bookkeeping. I live in Roseville.');
    check('1: education unknown → the next question asks for it, because shortlisted listings publish an education requirement', /highest level of education|college degree/i.test(it1.payload.flow?.question ?? '') && /listing/i.test(it1.payload.flow?.question ?? ''), it1.payload.flow?.question ?? it1.answer);
    const itR = await it('Show me the options you have so far', true);
    const itRes = itR.payload.flow?.stage === 'SHOWING_RESULTS' ? itR : await it('Show results anyway');
    const itJob = find(itRes, /Accounting Assistant/);
    check('1: with education unknown, the degree requirement is UNKNOWN — not unmet — and the card is not in the gap group', itJob?.requirements.find((r) => /college degree/i.test(r.text))?.status === 'unknown' && itJob.qualification.unmet === 0 && !(R(itRes)?.gapJobs ?? []).some((j) => j.id === itJob.id), JSON.stringify(itJob?.requirements));

    // 2. Applicant explicitly lacks a published requirement (Legal Clerk: "equivalent to completion of 12th grade").
    const a = await session('helper');
    await a("I'm helping someone who wants an office clerk job. He didn't finish high school and has no GED.");
    const aR = await a('Show me the options you have so far', true);
    const aRes = aR.payload.flow?.stage === 'SHOWING_RESULTS' ? aR : await a('Show results anyway');
    const fam = find(aRes, /Administrative Legal Clerk/);
    check('2: no diploma vs "equivalent to completion of 12th grade" → unmet, listed as missing, in "needs a qualification first"', !!fam && fam.qualification.unmet > 0 && (R(aRes)?.gapJobs ?? []).some((j) => j.id === fam.id) && fam.qualification.missing.some((m) => /12th grade/i.test(m)), JSON.stringify(all(aRes).map((j) => [j.title, j.qualification])));
    const careSession = await session('helper');
    await careSession("I'm helping a 19-year-old former foster youth interested in healthcare who hasn't completed her GED.");
    const careR0 = await careSession('Show me the options you have so far', true);
    const careRes = careR0.payload.flow?.stage === 'SHOWING_RESULTS' ? careR0 : await careSession('Show results anyway');
    const care = find(careRes, /Caregiver/);
    check('8: caregiver listing (no published education requirement) — no GED does not count against it; stays a best/related match', !!care && care.qualification.fit === 'no_published_requirements' && !(R(careRes)?.gapJobs ?? []).some((j) => j.id === care.id), JSON.stringify(care?.qualification));
    check('8: and no education question was asked for it before results', !/education|diploma|GED/i.test(careR0.payload.flow?.question ?? ''), careR0.payload.flow?.question ?? '');
    check('9: helper mode — qualification wording in the third person', /\bthey\b|\bHe\b/.test(aRes.answer) && !/\byou (said|described)\b/.test(aRes.answer), aRes.answer.slice(0, 400));

    // 3. Entry-level role without a degree requirement → no degree question; experience asked instead.
    const c = await session('self');
    const c1 = await c('I want an entry-level office clerk job. Highest is high school. I live in Auburn.');
    check('3: entry-level clerk role → no degree question; the published experience requirement is asked about', !/degree/i.test(c1.payload.flow?.question ?? '') && /years of administrative/i.test(c1.payload.flow?.question ?? ''), c1.payload.flow?.question ?? '');
    const c2 = await c('2-4 years');
    const cR = c2.payload.flow?.stage === 'SHOWING_RESULTS' ? c2 : await c('Show results anyway', true);
    const clerk = find(cR, /Administrative Legal Clerk/);
    check('3: 12th-grade requirement met by high school; 2 yrs clerical met by "2-4 years"', clerk?.requirements.filter((r) => r.mandatory).every((r) => r.status === 'met') === true, JSON.stringify(clerk?.requirements.map((r) => [r.text, r.status])));

    // 5. Skilled trade with documented experience and license → meets the published requirements.
    const e = await session('self');
    await e("I worked as an electrician for 6 years and I have a valid driver's license.");
    const eR = await e('Show me the options you have so far', true);
    const eRes = eR.payload.flow?.stage === 'SHOWING_RESULTS' ? eR : await e('Show results anyway');
    const elec = find(eRes, /^Electrician$/);
    check('5: electrician — 6 stated years and a license meet every published requirement; listed as a best match', elec?.qualification.fit === 'meets_published' && (R(eRes)?.bestJobs ?? []).some((j) => j.id === elec.id), JSON.stringify(elec?.requirements.map((r) => [r.text, r.status])));
    check('6/sidebar: experience and license appear in "What I know so far"', /6 years/.test(eRes.payload.flow?.knownFacts.experienceYears ?? '') && /driver/i.test(eRes.payload.flow?.knownFacts.certifications ?? ''), JSON.stringify(eRes.payload.flow?.knownFacts));

    // 6. Correcting experience flips the requirement and the grouping.
    const f = await session('self');
    await f('I worked as an electrician for 2 years.');
    const fR = await f('Show me the options you have so far', true);
    const fRes = fR.payload.flow?.stage === 'SHOWING_RESULTS' ? fR : await f('Show results anyway');
    const before = find(fRes, /^Electrician$/);
    const fixed = await f('Sorry, I meant I have 6 years as an electrician, and I do have a driver\'s license.');
    const after = find(fixed, /^Electrician$/);
    check('6: correction — 2 years → unmet (gap group); corrected to 6 years → met, re-ranked as FOLLOW_UP', before?.qualification.unmet === 1 && (R(fRes)?.gapJobs ?? []).some((j) => j.id === before.id) && fixed.payload.flow?.stage === 'FOLLOW_UP' && after?.qualification.unmet === 0 && after.requirements[0]!.status === 'met', `${JSON.stringify(before?.qualification)} → ${JSON.stringify(after?.qualification)}`);

    // 7. See Results without answering → one optional targeted question with "Show results anyway"; then results.
    const g = await session('self');
    await g('I have experience installing solar panels and want a better job.');
    const g2 = await g('Show me the options you have so far', true);
    const anyway = g2.payload.flow?.quickReplies.find((q) => /show results anyway/i.test(q.label));
    check('7: See Results with a requirement-deciding gap → one targeted question + "Show results anyway"', /^Before I show results/.test(g2.answer) && !!anyway && (g2.payload.flow?.quickReplies.length ?? 0) <= 4, JSON.stringify(g2.payload.flow));
    const g3 = await g('Show results anyway');
    const solarJobs = all(g3);
    check('7: "Show results anyway" → results; unknown requirements stay unknown and are named', g3.payload.flow?.stage === 'SHOWING_RESULTS' && solarJobs.length > 0 && solarJobs.every((j) => j.requirements.every((r) => r.status !== 'unmet')) && (g3.payload.flow?.uncertainties.length ?? 0) > 0, JSON.stringify(g3.payload.flow?.uncertainties));
    check('7: related-trade experience is not proof — electrician experience requirement stays unknown for a solar installer', find(g3, /^Electrician$/)?.requirements[0]?.status === 'unknown', JSON.stringify(find(g3, /^Electrician$/)?.requirements));

    // 10. Requirements verbatim, sourced from indexed chunks present in Qdrant.
    const v = await verifyRequirements([...all(itRes), ...all(aRes), ...all(careRes), ...all(cR), ...all(eRes), ...all(g3)]);
    check('10: every requirement is verbatim in its listing and cites PostgreSQL chunks present in Qdrant', v.ok, v.why);
    check('no card claims eligibility or hiring approval', ![itRes, aRes, cR, eRes, g3].some((t) => /\b(is|are) eligible\b|\bwill be hired\b|\bqualifies for the job\b/i.test(t.answer)), '');

    // Browser: pre-results question, "Show results anyway", expanded requirement comparison.
    const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
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
    await page.locator('[data-testid=mode-self]').click();
    const waitMore = async (n: number) => page.waitForFunction((k) => document.querySelectorAll('[data-testid=assistant-message]').length > k, n, { timeout: 150_000 });
    await page.locator('#navInput').fill("I worked as an electrician for 2 years. I don't have a college degree.");
    await page.locator('#navInput').press('Enter');
    await waitMore(0);
    await page.waitForTimeout(400);
    if (await page.locator('[data-testid=show-results]').count()) await page.locator('[data-testid=show-results]').click();
    else {
      await page.locator('#navInput').fill('Show me the options you have so far');
      await page.locator('#navInput').press('Enter');
    }
    await waitMore(1);
    await page.waitForTimeout(400);
    const anywayBtn = page.locator('[data-testid=quick-reply]', { hasText: 'Show results anyway' });
    const offered = (await anywayBtn.count()) === 1;
    await page.screenshot({ path: `${OUT}/1-pre-results-question.png` });
    if (offered) {
      await anywayBtn.click();
      await waitMore(2);
    }
    await page.locator('[data-testid=results]').last().waitFor({ timeout: 60_000 });
    const side = await page.locator('[data-testid=known-facts]').innerText();
    check('Browser: sidebar shows experience years and degree status', /2 years/.test(side) && /No college degree/i.test(side), side);
    const gapCard = page.locator('[data-testid=group-gaps] [data-testid=job-card]').first();
    check('Browser: electrician with 2 stated years appears under "Openings that need a qualification first"', (await gapCard.count()) === 1 && /Electrician/.test(await gapCard.innerText()), await page.locator('[data-testid=results]').last().innerText());
    await gapCard.locator('button[aria-expanded]').click();
    const det = await gapCard.locator('[data-testid=job-details]').innerText();
    await gapCard.screenshot({ path: `${OUT}/2-requirements-expanded.png` });
    check('Browser: expanded card shows requirements vs. stated facts, missing qualifications, sources and verification status', /Published requirements vs\. what was shared/i.test(det) && /Experience \(skilled trades\): 2 years/i.test(det) && (await gapCard.locator('[data-testid=missing-qualifications]').count()) === 1 && (await gapCard.locator('[data-testid=requirement-source]').count()) > 0 && /not an eligibility or hiring decision/i.test(det), det);
    check('Browser: no assumption alert', !/Assuming from what you/i.test(await page.locator('[data-testid=navigator]').innerText()));
    await page.screenshot({ path: `${OUT}/3-results.png` });
    await browser.close();
  } catch (err) {
    check('suite ran to completion', false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await prisma.chatSession.deleteMany({ where: { id: { in: sessions } } });
    await prisma.$disconnect();
  }
  const failed = checks.filter((x) => !x.ok).length;
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(checks, null, 2));
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
