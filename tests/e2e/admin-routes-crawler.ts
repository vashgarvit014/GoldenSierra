/**
 * Browser verification (real Chrome) of:
 *   1. canonical admin routes, sidebar, active state, breadcrumbs, legacy redirects
 *   2. Add Source → auto crawl → live stage progress → PostgreSQL + Qdrant → retrieval
 * against a controlled local test site (fictional, unique content). Run with:
 *   PORT=3100 npm run dev ; (.env must allow 127.0.0.1 in CRAWL_ALLOWED_HOSTS) ; npx tsx tests/e2e/admin-routes-crawler.ts
 * Everything it creates is removed through the product's own delete endpoints.
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { SITE_FACTS, startTestSite } from './fixtures/test-site';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const SITE_PORT = 4455;
const SITE_URL = `http://127.0.0.1:${SITE_PORT}/`;
const OUT = path.resolve(process.env.E2E_OUT ?? 'test-artifacts/routes');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODULES = [
  { label: 'Overview', route: '/admin', crumb: 'Overview', h1: /overview|workforce|good|welcome/i },
  { label: 'AI Workforce Chat', route: '/admin/chat', crumb: 'AI Workforce Chat', h1: /AI Workforce Chat/i },
  { label: 'Knowledge Base', route: '/admin/knowledge', crumb: 'Knowledge Base', h1: /Knowledge Base/i },
  { label: 'Website Crawler', route: '/admin/crawler', crumb: 'Website Crawler', h1: /Website Crawler/i },
  { label: 'RAG Testing Lab', route: '/admin/testing', crumb: 'RAG Testing Lab', h1: /RAG Testing Lab/i },
  { label: 'Analytics', route: '/admin/analytics', crumb: 'Analytics', h1: /Analytics/i },
  { label: 'Settings', route: '/admin/settings', crumb: 'Settings', h1: /Settings/i },
];

(async () => {
  const jobsAtStart = await prisma.ingestionJob.count();
  const docsAtStart = await prisma.document.count();
  const chunksAtStart = await prisma.documentChunk.count();
  const sourcesAtStart = await prisma.knowledgeSource.count();

  const site = await startTestSite(SITE_PORT);
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|Failed to load resource|negative time stamp/i.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  try {
    // ───────────── auth gate ─────────────
    await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
    check('signed out: /admin/crawler shows sign-in, not the console', (await page.locator('#email').count()) === 1 && (await page.locator('.sidebar').count()) === 0);
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.sidebar').waitFor({ timeout: 25_000 });
    // deep link lands on the module it names
    check('after sign-in the deep link stays on /admin/crawler', new URL(page.url()).pathname === '/admin/crawler', page.url());

    // ───────────── 1. routes ─────────────
    for (const m of MODULES) {
      await page.goto(`${BASE}${m.route}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.sidebar').waitFor();
      const active = await page.locator('.nav a[aria-current="page"]').allInnerTexts();
      check(`open ${m.route}: only "${m.label}" is active in the sidebar`, active.length === 1 && active[0]!.includes(m.label), JSON.stringify(active));
      check(`open ${m.route}: breadcrumb shows "${m.crumb}"`, ((await page.locator('#crumb').innerText()).trim()) === m.crumb);
      const heading = await page.locator('section.page.active h1').first().innerText().catch(() => '');
      check(`open ${m.route}: the ${m.label} module is the visible one`, m.h1.test(heading), heading);
      check(`open ${m.route}: tab title names the module`, (await page.title()).startsWith(m.crumb));
    }

    // sidebar clicks navigate client-side to the canonical URL
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.evaluate("window.__noReload = true");
    for (const m of MODULES.slice(1)) {
      await page.locator('.nav a', { hasText: m.label }).click();
      await page.waitForURL(`**${m.route}`);
      const active = await page.locator('.nav a[aria-current="page"]').allInnerTexts();
      check(`sidebar "${m.label}" → ${m.route}, active state follows`, active.length === 1 && active[0]!.includes(m.label), JSON.stringify(active));
    }
    check('sidebar navigation did not reload the page (state preserved)', (await page.evaluate("window.__noReload === true")) === true);
    await page.locator('.crumb-root').click();
    await page.waitForURL(`**/admin`);
    check('breadcrumb "Workspace" link returns to /admin', new URL(page.url()).pathname === '/admin');

    // legacy URLs
    for (const [from, to] of [['/admin/sources', '/admin/crawler'], ['/admin/config', '/admin/settings']] as const) {
      await page.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.sidebar').waitFor();
      check(`legacy ${from} redirects to ${to}`, new URL(page.url()).pathname === to, page.url());
    }
    await page.goto(`${BASE}/admin/programs`, { waitUntil: 'domcontentloaded' });
    check('/admin/programs (not a console module) still renders', (await page.locator('h1').first().innerText()).length > 0 && (await page.locator('.sidebar').count()) === 0);
    await page.goto(`${BASE}/admin/add-source`, { waitUntil: 'domcontentloaded' });
    check('/admin/add-source does not exist (Add Source lives in the crawler)', (await page.locator('h1').count()) === 0 || /404|not found/i.test(await page.locator('body').innerText()));

    // ───────────── 2. Add Source inside the crawler ─────────────
    await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
    check('crawler contains the Add Authorized Source form', (await page.getByRole('heading', { name: /Add an authorized source/i }).count()) === 1);
    check('crawler contains Knowledge Sources, Pipeline, and Ingestion Jobs', (await page.locator('h2', { hasText: 'Knowledge Sources' }).count()) === 1 && (await page.locator('h2', { hasText: /^Pipeline/ }).count()) === 1 && (await page.locator('h2', { hasText: /Ingestion Jobs/ }).count()) === 1);
    check('queue line states worker availability', /worker online|no worker|No Redis/i.test(await page.locator('#queueLine').innerText()), await page.locator('#queueLine').innerText());

    // server-side validation errors surface in the UI
    await page.locator('#urlInput').fill('https://example.com/');
    await page.locator('#addSourceBtn').click();
    await page.locator('#crawlerError').waitFor();
    check('unauthorized host: the server error is shown', /not authorized/i.test(await page.locator('#crawlerError').innerText()), await page.locator('#crawlerError').innerText());
    const sourcesAfterBad = await prisma.knowledgeSource.count();
    check('…and no source row was created', sourcesAfterBad === sourcesAtStart);

    // the real thing
    await page.evaluate("window.__noReload = true");
    await page.locator('#urlInput').fill(SITE_URL);
    await page.locator('#labelInput').fill('E2E Quillfeather test site');
    await page.locator('#addSourceBtn').click();

    const row = page.locator('tr[data-source-id]', { hasText: 'E2E Quillfeather test site' });
    await row.waitFor({ timeout: 15_000 });
    check('new source appears in the table without a page refresh', (await page.evaluate("window.__noReload === true")) === true);

    const source = await prisma.knowledgeSource.findFirstOrThrow({ where: { name: 'E2E Quillfeather test site' } });
    check('DB: KnowledgeSource row saved with the validated URL', source.rootUrl === SITE_URL && source.status === 'ACTIVE', JSON.stringify(source.rootUrl));
    const job0 = await prisma.ingestionJob.findFirst({ where: { sourceId: source.id }, orderBy: { createdAt: 'desc' } });
    check('DB: first crawl job was created automatically', !!job0 && job0.type === 'CRAWL', JSON.stringify(job0?.type));

    // observe live progress, with no reload, until the job finishes
    const seen = { statuses: new Set<string>(), running: new Set<string>(), completed: new Set<string>() };
    let sawQueueOrRunning = false;
    const t0 = Date.now();
    let finalStatus = '';
    while (Date.now() - t0 < 120_000) {
      const card = page.locator(`#jobsPanel [data-job-id="${job0!.id}"]`);
      if (await card.count()) {
        const st = (await card.locator('[data-testid=job-status]').innerText()).trim();
        seen.statuses.add(st);
        if (st === 'queued' || st === 'running') sawQueueOrRunning = true;
        const steps = await card.locator('.pipeline-step').evaluateAll((els) => els.map((e) => [e.getAttribute('data-stage'), e.getAttribute('data-state')]));
        for (const [id, state] of steps as [string, string][]) {
          if (state === 'running') seen.running.add(id);
          if (state === 'completed') seen.completed.add(id);
        }
        if (st === 'completed' || st === 'failed') { finalStatus = st; break; }
      }
      await sleep(350);
    }
    await page.screenshot({ path: `${OUT}/crawler-after-crawl.png`, fullPage: true });
    check('job reached COMPLETED', finalStatus === 'completed', finalStatus || 'timeout');
    check('UI showed a live (queued/running) state before completion', sawQueueOrRunning, [...seen.statuses].join(','));
    check('UI never reloaded while tracking', (await page.evaluate("window.__noReload === true")) === true);
    check('all five stages ended completed in the UI', ['discover', 'extract', 'chunk', 'embed', 'index'].every((s) => seen.completed.has(s)), `completed: ${[...seen.completed]}`);
    console.log(`      stages observed running: ${[...seen.running].join(', ') || '(none caught — fast crawl)'}`);

    // ───────────── PostgreSQL + Qdrant ─────────────
    const job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job0!.id } });
    const progress = job.progress as { stages: Record<string, { state: string; done: number; total: number | null; count: number }> } | null;
    check('DB: job COMPLETED with stored per-stage progress', job.status === 'COMPLETED' && !!progress, job.status);
    const docs = await prisma.document.findMany({ where: { sourceId: source.id }, include: { chunks: true } });
    check('DB: 3 pages stored and INDEXED', docs.length === 3 && docs.every((d) => d.status === 'INDEXED'), `${docs.length} docs ${docs.map((d) => d.status)}`);
    const chunks = docs.flatMap((d) => d.chunks);
    check('DB: every chunk has a vector id', chunks.length > 0 && chunks.every((c) => !!c.vectorId), `${chunks.length}`);
    check('progress counters equal real work: chunk/embed/index docs == 3, chunk count == DB chunks', progress?.stages.chunk?.done === 3 && progress?.stages.embed?.done === 3 && progress?.stages.index?.done === 3 && progress?.stages.chunk?.count === chunks.length, JSON.stringify(progress?.stages));
    const q = getQdrant();
    let points = 0;
    for (const d of docs) {
      points += (await q.count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { value: d.id } }] } })).count;
    }
    check('Qdrant: point count for the source equals Postgres chunk count', points === chunks.length, `${points} vs ${chunks.length}`);
    await sleep(2500); // let the page's last poll land
    check('UI: source row says enabled / completed / ready', (await row.locator('[data-testid=source-status]').innerText()).trim() === 'enabled' && (await row.locator('[data-testid=crawl-status]').innerText()).trim() === 'completed' && (await row.locator('[data-testid=retrieval-state]').innerText()).trim() === 'ready', await row.innerText());
    check('UI: document column reports 3 indexed', /3\s*indexed/.test(await row.locator('[data-testid=doc-state]').innerText()));

    // duplicate prevention (different spelling of the same site)
    await page.locator('#urlInput').fill(`http://127.0.0.1:${SITE_PORT}`);
    await page.locator('#labelInput').fill('duplicate attempt');
    await page.locator('#addSourceBtn').click();
    await page.locator('#crawlerError').waitFor();
    check('duplicate source is rejected with the existing source named', /already a source/i.test(await page.locator('#crawlerError').innerText()) && /E2E Quillfeather/.test(await page.locator('#crawlerError').innerText()), await page.locator('#crawlerError').innerText());
    check('…and no second source or job was created', (await prisma.knowledgeSource.count({ where: { rootUrl: { startsWith: `http://127.0.0.1:${SITE_PORT}` } } })) === 1 && (await prisma.ingestionJob.count({ where: { sourceId: source.id } })) === 1);

    // pause blocks crawling
    await row.getByRole('button', { name: 'Pause' }).click();
    await page.waitForFunction(`document.querySelector('tr[data-source-id="${source.id}"] [data-testid=source-status]')?.textContent.trim() === 'paused'`);
    check('pausing shows "paused" and disables Crawl', await row.locator('[data-action=crawl]').isDisabled());
    await row.getByRole('button', { name: 'Resume' }).click();
    await page.waitForFunction(`document.querySelector('tr[data-source-id="${source.id}"] [data-testid=source-status]')?.textContent.trim() === 'enabled'`);

    // ───────────── retrieval ─────────────
    const QUESTION = `How much is the stipend for the ${SITE_FACTS.program}?`;
    await page.locator('.nav a', { hasText: 'RAG Testing Lab' }).click();
    await page.waitForURL('**/admin/testing');
    await page.locator('#testQuery').fill(QUESTION);
    await page.getByRole('button', { name: /Run test/ }).click();
    await page.waitForFunction(`document.querySelector('section.page.active')?.innerText.includes('Retrieved passages')`, null, { timeout: 90_000 });
    const lab = await page.locator('section.page.active').innerText();
    await page.screenshot({ path: `${OUT}/testing-lab.png`, fullPage: true });
    check('RAG Testing Lab: retrieved passages come from the new source', /127\.0\.0\.1:4455/.test(lab), lab.slice(0, 200));
    check('RAG Testing Lab: answer contains the unique stipend fact', lab.includes('4,217'), '');

    await page.locator('.nav a', { hasText: 'AI Workforce Chat' }).click();
    await page.waitForURL('**/admin/chat');
    await page.locator('#chatInput').waitFor({ state: 'visible' });
    await page.waitForFunction(`!document.querySelector('#chatInput').disabled`, null, { timeout: 30_000 });
    await page.locator('#chatInput').fill(QUESTION);
    await page.locator('#chatInput').press('Enter');
    await page.waitForFunction(`document.querySelector('section.page.active')?.innerText.includes('4,217')`, null, { timeout: 90_000 }).catch(() => undefined);
    const adminChat = await page.locator('section.page.active').innerText();
    await page.screenshot({ path: `${OUT}/admin-chat.png`, fullPage: true });
    check('Admin AI Workforce Chat answers from the new source ($4,217)', adminChat.includes('4,217'), adminChat.slice(-300));

    // public chatbot
    const pub = await context.newPage();
    let pubText = '';
    const retrieved: string[] = [];
    pub.on('response', async (r) => {
      if (!r.url().endsWith('/api/session') || r.request().method() !== 'POST') return;
      try {
        const j = (await r.json()) as { turn?: { sources?: { url: string; title: string }[]; message?: string } };
        for (const src of j.turn?.sources ?? []) retrieved.push(`${src.url} | ${src.title}`);
      } catch { /* not a turn response */ }
    });
    try {
      await pub.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await pub.getByRole('button', { name: /looking for myself/i }).click();
      await pub.locator('textarea').first().waitFor({ timeout: 20_000 });
      // The public bot is a guided counselor: it asks before it recommends, so
      // talk to it the way a visitor would until results appear.
      const turns = ['I live in Alpine County, I am unemployed and I want to train as a welder with a paid stipend', 'I have no car', 'I need income quickly', 'show me my options'];
      for (const turn of turns) {
        if (retrieved.some((x) => x.includes('/fellowship'))) break;
        const box = pub.locator('textarea').first();
        await box.waitFor({ state: 'visible', timeout: 30_000 });
        await pub.waitForFunction(`!document.querySelector('textarea')?.disabled`, null, { timeout: 60_000 });
        await box.fill(turn);
        await box.press('Enter');
        await pub.waitForFunction(`document.body.innerText.includes('Quillfeather') || !document.querySelector('textarea')?.disabled`, null, { timeout: 90_000 }).catch(() => undefined);
        await pub.waitForTimeout(1500);
      }
      pubText = await pub.locator('body').innerText();
      await pub.screenshot({ path: `${OUT}/public-chat.png`, fullPage: true });
    } catch (e) {
      pubText = `ERROR ${String(e).slice(0, 200)}`;
    }
    check('Public chatbot retrieves the new source: its /api/session turn lists http://127.0.0.1:4455/fellowship', retrieved.some((x) => x.startsWith(`http://127.0.0.1:${SITE_PORT}/fellowship`) && /Quillfeather/.test(x)), `retrieved ${retrieved.length}: ${retrieved.slice(0, 3).join(' ; ')} | page: ${pubText.replace(/\s+/g, ' ').slice(-200)}`);
    await pub.close();

    // ───────────── role permissions in the UI ─────────────
    const { hashPassword } = await import('../../src/lib/auth');
    const viewerEmail = `viewer-ui-${Date.now()}@test.invalid`;
    const viewerPw = 'ViewerPassw0rd!';
    const viewerUser = await prisma.adminUser.create({ data: { email: viewerEmail, passwordHash: await hashPassword(viewerPw), role: 'VIEWER' } });
    try {
      const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const vp = await vctx.newPage();
      await vp.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      await vp.locator('#email').fill(viewerEmail);
      await vp.locator('#password').fill(viewerPw);
      await vp.getByRole('button', { name: 'Sign in' }).click();
      await vp.locator('.sidebar').waitFor({ timeout: 25_000 });
      await vp.waitForTimeout(1500);
      check('VIEWER sees the crawler read-only: no Add Source form, no Crawl/Re-index buttons', (await vp.locator('#urlInput').count()) === 0 && (await vp.locator('[data-action=crawl]').count()) === 0 && (await vp.getByRole('button', { name: /Re-index all/ }).count()) === 0);
      check('VIEWER still sees Knowledge Sources and jobs', (await vp.locator('h2', { hasText: 'Knowledge Sources' }).count()) === 1);
      for (const route of ['/admin/chat', '/admin/analytics', '/admin/settings']) {
        await vp.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
        await vp.locator('.sidebar').waitFor();
        check(`VIEWER can open ${route}`, new URL(vp.url()).pathname === route);
      }
      await vctx.close();
    } finally {
      await prisma.adminUser.delete({ where: { id: viewerUser.id } });
    }

    check('no unexpected browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    // ───────────── cleanup via the product's own endpoints ─────────────
    const cookies = await context.cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const src = await prisma.knowledgeSource.findFirst({ where: { name: 'E2E Quillfeather test site' } });
    if (src) {
      const docs = await prisma.document.findMany({ where: { sourceId: src.id }, select: { id: true } });
      for (const d of docs) await fetch(`${BASE}/api/admin/documents/${d.id}?hard=true`, { method: 'DELETE', headers: { cookie } });
      await fetch(`${BASE}/api/admin/sources/${src.id}`, { method: 'DELETE', headers: { cookie } });
      await prisma.ingestionJob.deleteMany({ where: { OR: [{ sourceId: src.id }, { params: { path: ['sourceId'], equals: src.id } }] } });
    }
    await prisma.ingestionJob.deleteMany({ where: { sourceId: null, createdAt: { gt: new Date(Date.now() - 20 * 60_000) }, type: 'CRAWL' } });
    check('cleanup restored sources/documents/chunks', (await prisma.knowledgeSource.count()) === sourcesAtStart && (await prisma.document.count()) === docsAtStart && (await prisma.documentChunk.count()) === chunksAtStart,
      `src ${await prisma.knowledgeSource.count()}/${sourcesAtStart} docs ${await prisma.document.count()}/${docsAtStart} chunks ${await prisma.documentChunk.count()}/${chunksAtStart}`);
    console.log(`jobs now ${await prisma.ingestionJob.count()} (start ${jobsAtStart})`);
    await browser.close();
    site.close();
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
