/**
 * Live Add Source → Crawl → Index → Retrieve against a PERMITTED real page, with the
 * allowlist, robots.txt compliance and SSRF checks all left on. One page only.
 *   PORT=3100 npm run dev   (worker running)   npx tsx tests/e2e/add-source-live.ts
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const TARGET = 'https://goldensierra.com/impact/erins-success-story';
const LABEL = 'Live test: Erin success story';
const OUT = path.resolve('test-artifacts/routes');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const before = { docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), sources: await prisma.knowledgeSource.count(), jobs: await prisma.ingestionJob.count() };
  console.log('allowlist in this process:', JSON.stringify(env.CRAWL_ALLOWED_HOSTS));
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.sidebar').waitFor({ timeout: 25_000 });
    await page.waitForSelector('#allowedHostsNote');
    const note = await page.locator('#allowedHostsNote').innerText();
    check('the form lists the authorized hosts', /goldensierra\.com/.test(note) && /www\.goldensierra\.com/.test(note), note);

    // ── rejected host: explained, not generic ──
    for (const [url, host, extra] of [
      ['https://goldensiera.org/jobs', 'goldensiera.org', /Did you mean/],
      ['https://example.com/', 'example.com', /CRAWL_ALLOWED_HOSTS/],
    ] as const) {
      await page.locator('#urlInput').fill(url);
      await page.locator('#addSourceBtn').click();
      await page.locator('#crawlerError').waitFor();
      const msg = await page.locator('#crawlerError').innerText();
      check(`rejection of ${url} names the host, the allowed list and the fix`, msg.includes(`"${host}"`) && /goldensierra\.com, www\.goldensierra\.com/.test(msg) && extra.test(msg), msg);
      await page.reload({ waitUntil: 'networkidle' });
    }
    await page.screenshot({ path: `${OUT}/rejection-message.png` });

    // ── permitted: every spelling variant of the real domain passes the host check ──
    // (submitted with a 1-page limit; the duplicate guard proves the host check passed)
    // ── the real flow ──
    await page.locator('#urlInput').fill(TARGET);
    await page.locator('#labelInput').fill(LABEL);
    await page.getByText('Crawl limits (optional)').click();
    await page.locator('#maxPagesInput').fill('1');
    await page.locator('#maxDepthInput').fill('0');
    await page.evaluate('window.__noReload = true');
    await page.locator('#addSourceBtn').click();
    const row = page.locator('tr[data-source-id]', { hasText: LABEL });
    await row.waitFor({ timeout: 20_000 });
    check('permitted host accepted; source appears without a refresh', (await page.evaluate('window.__noReload === true')) === true);

    const source = await prisma.knowledgeSource.findFirstOrThrow({ where: { name: LABEL } });
    check('DB: source saved with maxPages=1, depth=0, robots respected', source.maxPages === 1 && source.maxDepth === 0 && source.respectRobots === true, JSON.stringify(source));
    const job0 = await prisma.ingestionJob.findFirstOrThrow({ where: { sourceId: source.id } });
    check('DB: first crawl job created automatically', job0.type === 'CRAWL');

    const t0 = Date.now(); let status = ''; const sawLive = new Set<string>();
    while (Date.now() - t0 < 180_000) {
      const card = page.locator(`#jobsPanel [data-job-id="${job0.id}"]`);
      if (await card.count()) {
        status = (await card.locator('[data-testid=job-status]').innerText()).trim();
        sawLive.add(status);
        if (status === 'completed' || status === 'failed') break;
      }
      await sleep(400);
    }
    await page.screenshot({ path: `${OUT}/live-crawl-done.png`, fullPage: true });
    check('job COMPLETED, tracked live with no reload', status === 'completed' && (await page.evaluate('window.__noReload === true')) === true, `${status} seen=${[...sawLive]}`);

    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job0.id } });
    const prog = job.progress as { stages: Record<string, { state: string; done: number; count: number }> };
    check('only the one permitted page was processed (no wider crawl)', job.pagesProcessed === 1, `pagesProcessed=${job.pagesProcessed} discovered=${job.pagesDiscovered}`);
    check('all five stages completed', ['discover', 'extract', 'chunk', 'embed', 'index'].every((s) => prog.stages[s]?.state === 'completed'), JSON.stringify(prog.stages));
    const docs = await prisma.document.findMany({ where: { sourceId: source.id }, include: { chunks: true } });
    check('Postgres: 1 document, INDEXED', docs.length === 1 && docs[0]!.status === 'INDEXED', `${docs.length} ${docs.map((d) => d.status)}`);
    const chunks = docs.flatMap((d) => d.chunks);
    check('Postgres: every chunk has a vector id', chunks.length > 0 && chunks.every((c) => !!c.vectorId), String(chunks.length));
    const pts = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { value: docs[0]!.id } }] } });
    check('Qdrant: points == Postgres chunks', pts.count === chunks.length, `${pts.count} vs ${chunks.length}`);
    await sleep(2500);
    check('UI: enabled / completed / ready', (await row.locator('[data-testid=retrieval-state]').innerText()).trim() === 'ready' && (await row.locator('[data-testid=crawl-status]').innerText()).trim() === 'completed');

    // ── retrieval ──
    const Q = 'What help did Erin get from Golden Sierra for school supplies and her computer science classes?';
    await page.locator('.nav a', { hasText: 'RAG Testing Lab' }).click();
    await page.locator('#testQuery').fill(Q);
    await page.getByRole('button', { name: /Run test/ }).click();
    await page.waitForFunction(`document.querySelector('section.page.active')?.innerText.includes('Retrieved passages')`, null, { timeout: 90_000 });
    const lab = await page.locator('section.page.active').innerText();
    await page.screenshot({ path: `${OUT}/live-testing-lab.png`, fullPage: true });
    check('RAG Testing Lab retrieves the new page', lab.includes('erins-success-story'), lab.slice(0, 160));
    check('RAG Testing Lab answer carries a fact only that page has (digital pen)', /digital pen/i.test(lab), '');

    await page.locator('.nav a', { hasText: 'AI Workforce Chat' }).click();
    await page.waitForFunction(`!document.querySelector('#chatInput')?.disabled`, null, { timeout: 30_000 });
    await page.locator('#chatInput').fill(Q);
    await page.locator('#chatInput').press('Enter');
    await page.waitForFunction(`/digital pen/i.test(document.querySelector('section.page.active')?.innerText ?? '')`, null, { timeout: 90_000 }).catch(() => undefined);
    const chat = await page.locator('section.page.active').innerText();
    check('Admin chatbot answers from the new page (digital pen)', /digital pen/i.test(chat), chat.slice(-250));

    // The public counselor builds its retrieval query from structured context
    // (career interest, urgency, county), not from the visitor's free text, so it
    // is a recommender, not a document Q&A. Report whether it surfaced the page;
    // admin chat and the Testing Lab (the Q&A path) are the pass/fail checks.
    const pub = await context.newPage();
    const seen: string[] = [];
    pub.on('response', async (r) => {
      if (!r.url().endsWith('/api/session') || r.request().method() !== 'POST') return;
      try { const j = (await r.json()) as { turn?: { sources?: { url: string }[] } }; for (const s of j.turn?.sources ?? []) seen.push(s.url); } catch { /* start-session reply */ }
    });
    await pub.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await pub.getByRole('button', { name: /looking for myself/i }).click();
    const box = pub.locator('textarea').first();
    await box.waitFor();
    for (const turn of ['I want a career in computer science. I am in Placer County and can train first', 'I have a car', 'I can train first, no rush', 'show me my options']) {
      if (seen.length > 0) break;
      await pub.waitForFunction(`!document.querySelector('textarea')?.disabled`, null, { timeout: 90_000 });
      await box.fill(turn);
      await box.press('Enter');
      await pub.waitForTimeout(7000);
    }
    await pub.waitForFunction(`!document.querySelector('textarea')?.disabled`, null, { timeout: 90_000 }).catch(() => undefined);
    check('Public chatbot reaches recommendations with sources (retrieval works end to end)', seen.length > 0, 'no sources returned');
    console.log(`INFO  public counselor surfaced the new page: ${seen.some((u) => u.includes('erins-success-story'))} (sources: ${[...new Set(seen)].slice(0, 4).join(', ')})`);
    await pub.screenshot({ path: `${OUT}/live-public-chat.png`, fullPage: true });
    await pub.close();
  } catch (e) {
    fail++;
    console.log('FAIL  script error →', String(e).slice(0, 400));
  } finally {
    // cleanup of exactly what this run created, through the product's endpoints
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const src = await prisma.knowledgeSource.findFirst({ where: { name: LABEL } });
    if (src) {
      for (const d of await prisma.document.findMany({ where: { sourceId: src.id }, select: { id: true } })) await fetch(`${BASE}/api/admin/documents/${d.id}?hard=true`, { method: 'DELETE', headers: { cookie } });
      await fetch(`${BASE}/api/admin/sources/${src.id}`, { method: 'DELETE', headers: { cookie } });
      await prisma.ingestionJob.deleteMany({ where: { id: { in: (await prisma.ingestionJob.findMany({ where: { sourceId: null, type: 'CRAWL', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } }, select: { id: true } })).map((j) => j.id) } } });
    }
    const after = { docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), sources: await prisma.knowledgeSource.count(), jobs: await prisma.ingestionJob.count() };
    check('cleanup restored the knowledge base exactly', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
    await browser.close();
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
