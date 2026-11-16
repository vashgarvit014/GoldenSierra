/**
 * Browser verification (real Chrome) of the dynamic, multi-website crawler.
 *
 *   PHASE=A  strict, production-like servers: real internet + every rejection
 *   PHASE=B  fixtures: dev server AND worker started with CRAWL_TEST_ALLOW_PRIVATE=1
 *            (never honoured in production) so *.localtest.me fixtures can be crawled
 *
 * Everything created is removed through the product's own endpoints.
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import { retrieve } from '../../src/lib/rag/retrieve';
import { FACTS, startMultiSite } from './fixtures/multi-site';

const PHASE = (process.env.PHASE ?? 'A').toUpperCase();
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const PORT = 4455;
const OUT = path.resolve(process.env.E2E_OUT ?? 'test-artifacts/universal');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${String(detail).slice(0, 500)}`}`); };
const info = (m: string) => console.log(`INFO  ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LABELS = new Set<string>();

// ───────────── helpers ─────────────
async function login(page: Page) {
  await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
  await page.locator('#email').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.sidebar').waitFor({ timeout: 25_000 });
}

/** Submits the Add Source form and reports what the user sees. */
async function uiAdd(page: Page, url: string, label: string, opts: { depth?: number; max?: number } = {}) {
  await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
  await page.locator('#urlInput').fill(url);
  await page.locator('#labelInput').fill(label);
  await page.locator('#maxDepthInput').fill(String(opts.depth ?? 3));
  await page.locator('#maxPagesInput').fill(String(opts.max ?? 30));
  LABELS.add(label);
  await page.locator('#addSourceBtn').click();
  const row = page.locator('tr[data-source-id]', { hasText: label });
  const outcome = await Promise.race([
    page.locator('#crawlerError').waitFor({ timeout: 20_000 }).then(() => 'error' as const),
    row.waitFor({ timeout: 20_000 }).then(() => 'row' as const),
  ]).catch(() => 'none' as const);
  const error = outcome === 'error' ? (await page.locator('#crawlerError').innerText()).trim() : null;
  return { outcome, error, row };
}

const source = (label: string) => prisma.knowledgeSource.findFirst({ where: { name: label } });

/** Waits for a source's newest job to reach a final state and stay there. */
async function finalJob(sourceId: string, ms = 150_000, settleMs = 0) {
  const t0 = Date.now();
  let last = '';
  let since = 0;
  while (Date.now() - t0 < ms) {
    const j = await prisma.ingestionJob.findFirst({ where: { sourceId }, orderBy: { createdAt: 'desc' } });
    if (j && !['QUEUED', 'RUNNING'].includes(j.status)) {
      if (j.status !== last) { last = j.status; since = Date.now(); }
      if (Date.now() - since >= settleMs) return j;
    } else last = '';
    await sleep(500);
  }
  return prisma.ingestionJob.findFirst({ where: { sourceId }, orderBy: { createdAt: 'desc' } });
}

async function docsOf(sourceId: string) {
  return prisma.document.findMany({ where: { sourceId }, include: { chunks: true } });
}
async function pointsFor(docIds: string[]) {
  if (!docIds.length) return 0;
  const r = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'documentId', match: { any: docIds } }] } });
  return r.count;
}
async function pointPayloads(docIds: string[]) {
  const r = await getQdrant().scroll(env.QDRANT_COLLECTION, { filter: { must: [{ key: 'documentId', match: { any: docIds } }] }, limit: 500, with_payload: ['sourceId', 'url', 'title'], with_vector: false });
  return r.points.map((p) => p.payload as { sourceId?: string; url?: string; title?: string });
}

async function ask(context: BrowserContext, question: string, waitFor: RegExp, where: 'chat' | 'testing' = 'testing') {
  const page = await context.newPage();
  try {
    if (where === 'testing') {
      await page.goto(`${BASE}/admin/testing`, { waitUntil: 'networkidle' });
      await page.locator('#testQuery').fill(question);
      await page.getByRole('button', { name: /Run test/ }).click();
      await page.waitForFunction(`document.querySelector('section.page.active')?.innerText.includes('Retrieved passages')`, null, { timeout: 90_000 }).catch(() => undefined);
    } else {
      await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
      await page.waitForFunction(`!document.querySelector('#chatInput')?.disabled`, null, { timeout: 30_000 });
      await page.locator('#chatInput').fill(question);
      await page.locator('#chatInput').press('Enter');
      await page.waitForFunction(`/${waitFor.source}/i.test(document.querySelector('section.page.active')?.innerText ?? '')`, null, { timeout: 90_000 }).catch(() => undefined);
    }
    await sleep(500);
    return await page.locator('section.page.active').innerText();
  } finally {
    await page.close();
  }
}

async function apiAs(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      let j: unknown = null;
      try { j = await r.json(); } catch { /* none */ }
      return { status: r.status, body: j as any };
    },
    { method, url, body },
  );
}

async function removeViaApi(page: Page, label: string) {
  const s = await source(label);
  if (!s) return;
  for (const d of await prisma.document.findMany({ where: { sourceId: s.id }, select: { id: true } })) await apiAs(page, 'DELETE', `/api/admin/documents/${d.id}?hard=true`);
  await apiAs(page, 'DELETE', `/api/admin/sources/${s.id}?documents=keep`);
}

// ───────────── main ─────────────
(async () => {
  const base = { sources: await prisma.knowledgeSource.count(), docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), jobs: await prisma.ingestionJob.count() };
  const sourceDocBaseline = await prisma.document.groupBy({ by: ['sourceId'], _count: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource|negative time stamp/i.test(m.text())) consoleErrors.push(m.text()); });
  let fixtures: Awaited<ReturnType<typeof startMultiSite>> | undefined;

  try {
    await login(page);
    check('policy note says any public site can be added, with limits', /any public website/i.test(await page.locator('#policyNote').innerText()) && /private|local|internal/i.test(await page.locator('#policyNote').innerText()));

    if (PHASE === 'A') {
      // ─── Task 9 #6 / #7 / #8 and friends: everything the server must refuse ───
      const auditBefore = await prisma.auditLog.count({ where: { action: 'source_rejected' } });
      const rejections: [string, string, RegExp][] = [
        ['scheme', 'javascript:alert(1)', /https|http\(s\)|scheme/i],
        ['plain http', 'http://example.org/', /HTTPS/i],
        ['credentials', 'https://user:hunter2@example.org/', /credentials/i],
        ['localhost', 'https://localhost/', /internal|local/i],
        ['loopback IP', 'https://127.0.0.1/', /private|loopback|reserved/i],
        ['private 10/8', 'https://10.0.0.5/', /private|reserved/i],
        ['private 192.168/16', 'https://192.168.1.10/', /private|reserved/i],
        ['link-local', 'https://169.254.169.254/latest/meta-data/', /private|link-local|reserved|metadata/i],
        ['IPv6 loopback', 'https://[::1]/', /private|loopback|reserved/i],
        ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/', /private|reserved/i],
        ['decimal IP', 'https://2130706433/', /private|loopback|reserved/i],
        ['metadata hostname', 'https://metadata.google.internal/', /internal|metadata/i],
        ['DNS → private', 'https://alpha.localtest.me/', /resolves to a private/i],
      ];
      for (const [name, url, re] of rejections) {
        const r = await uiAdd(page, url, `E2E reject ${name}`);
        check(`rejected (${name}): ${url}`, r.outcome === 'error' && re.test(r.error ?? ''), `${r.outcome} ${r.error}`);
        check(`  …and the message never leaks credentials`, !/hunter2/.test(r.error ?? ''));
      }
      check('rejections created no source rows', (await prisma.knowledgeSource.count()) === base.sources);
      check('rejections were audit-logged (security events)', (await prisma.auditLog.count({ where: { action: 'source_rejected' } })) >= auditBefore + rejections.length, String(await prisma.auditLog.count({ where: { action: 'source_rejected' } })));

      // invalid URL: the browser blocks it client-side, and the server rejects it independently
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      await page.locator('#urlInput').fill('not a url');
      check('invalid URL: browser validation flags it before any request', (await page.locator('#urlInput').evaluate((el) => (el as HTMLInputElement).validity.typeMismatch)) === true);
      const serverSide = await apiAs(page, 'POST', '/api/admin/sources', { name: 'E2E invalid', type: 'WEBSITE', rootUrl: 'not a url', startCrawl: false });
      check('invalid URL: the server rejects it too (400 invalid_url)', serverSide.status === 400 && serverSide.body?.details?.reason === 'invalid_url', JSON.stringify(serverSide));

      // ─── #1 authorized public website on the real internet ───
      const IANA = 'https://www.iana.org/help/example-domains';
      const add = await uiAdd(page, IANA, 'E2E real public site', { depth: 0, max: 1 });
      check('real public HTTPS site accepted — no domain configuration needed', add.outcome === 'row', add.error ?? '');
      const src = await source('E2E real public site');
      if (src) {
        const job = await finalJob(src.id, 120_000);
        check('crawl COMPLETED', job?.status === 'COMPLETED', `${job?.status} ${job?.error}`);
        check('only the one page was processed (page budget respected)', job?.pagesProcessed === 1, String(job?.pagesProcessed));
        const docs = await docsOf(src.id);
        check('Postgres: 1 document, INDEXED, scoped to the registered source', docs.length === 1 && docs[0]!.status === 'INDEXED' && docs[0]!.sourceId === src.id);
        const chunks = docs.flatMap((d) => d.chunks);
        check('Postgres: every chunk has a vector id', chunks.length > 0 && chunks.every((c) => !!c.vectorId), String(chunks.length));
        check('Qdrant: points == chunks', (await pointsFor(docs.map((d) => d.id))) === chunks.length);
        const payloads = await pointPayloads(docs.map((d) => d.id));
        check('Qdrant: every point carries this source\'s id and the page URL (citation data)', payloads.length > 0 && payloads.every((p) => p.sourceId === src.id && p.url === IANA), JSON.stringify(payloads[0]));
        await sleep(2500);
        const row = page.locator('tr[data-source-id]', { hasText: 'E2E real public site' });
        check('UI: enabled · completed · ready', (await row.locator('[data-testid=source-status]').innerText()).trim() === 'enabled' && (await row.locator('[data-testid=crawl-status]').innerText()).trim() === 'completed' && (await row.locator('[data-testid=retrieval-state]').innerText()).trim() === 'ready');
        // retrieval at the retrieval layer, restricted to the new source
        const analysis = { intent: 'general_info' as const, confidence: 0.9, rewrittenQuery: 'RFC 2606 RFC 6761 example domains reserved for documentation', keywords: ['RFC 2606', 'example domains'], profileUpdates: {}, missingInfo: null, isMultiPart: false, subQuestions: [] };
        const got = await retrieve(analysis as never, {} as never, { sourceIds: [src.id] });
        info(`retrieval (scoped to the new source): ${got.sources.length} passages; top: ${got.sources[0]?.url} :: ${(got.sources[0]?.snippet ?? '').slice(0, 90).replace(/\s+/g, ' ')}`);
        check('retrieval: scoped search returns passages containing "RFC 2606" from that exact URL', got.sources.length > 0 && got.sources.every((s) => s.url === IANA && s.sourceId === src.id) && got.sources.some((s) => /RFC\s*2606/.test(s.snippet)));
        const other = await retrieve(analysis as never, {} as never, { sourceIds: ['not-a-real-source'] });
        check('retrieval: a different source filter returns nothing from it', other.sources.length === 0);
        const unscoped = await retrieve(analysis as never, {} as never);
        info(`retrieval (unscoped): top = ${unscoped.sources[0]?.url}`);

        // ─── #2 duplicate ───
        const dup = await uiAdd(page, 'https://iana.org/help/example-domains/?utm_source=x', 'E2E duplicate attempt');
        check('duplicate website rejected, naming the existing source', dup.outcome === 'error' && /already a source/i.test(dup.error ?? '') && /E2E real public site/.test(dup.error ?? ''), dup.error ?? '');
        check('…and no extra source or job', (await prisma.knowledgeSource.count({ where: { rootUrl: { contains: 'iana.org' } } })) === 1 && (await prisma.ingestionJob.count({ where: { sourceId: src.id } })) === 1);
      }
    } else {
      // ─────────────────────────── PHASE B: fixtures ───────────────────────────
      fixtures = await startMultiSite(PORT);
      const U = (host: string) => `http://${host}.localtest.me:${PORT}/`;
      const probe = await uiAdd(page, U('alpha'), 'E2E alpha', { depth: 3, max: 40 });
      if (probe.outcome !== 'row') {
        console.log(`ABORT: fixtures need CRAWL_TEST_ALLOW_PRIVATE=1 on the dev server and worker. Server said: ${probe.error}`);
        throw new Error('fixture switch is off');
      }

      // ─── multi-page site with redirects, sitemap, duplicates, off-scope links, robots, a broken link and an SPA ───
      const alpha = (await source('E2E alpha'))!;
      const jA = await finalJob(alpha.id, 150_000);
      await page.screenshot({ path: `${OUT}/alpha-crawled.png`, fullPage: true });
      check('alpha: PARTIAL (usable content + one broken link), never plain COMPLETED', jA?.status === 'PARTIAL', `${jA?.status} ${jA?.error}`);
      check('alpha: error text explains what failed', /1 page failed|failed/i.test(jA?.error ?? '') && /404/.test(jA?.error ?? ''), jA?.error ?? '');
      const dA = await docsOf(alpha.id);
      const urls = new Set(dA.map((d) => d.url));
      for (const [label, p] of [['home', '/'], ['linked page', '/programs'], ['redirect target (/old-page → /new-page)', '/new-page'], ['sitemap-only page', '/hidden-guide'], ['canonical page', '/dupe-a']] as const) {
        check(`alpha: indexed ${label}`, urls.has(`http://alpha.localtest.me:${PORT}${p === '/' ? '' : p}`) || urls.has(`http://alpha.localtest.me:${PORT}${p}`), [...urls].join(','));
      }
      check('alpha: the canonical duplicate was indexed once (dupe-b skipped)', !dA.some((d) => d.url?.endsWith('/dupe-b')) && dA.filter((d) => /dupe-/.test(d.url ?? '')).length === 1);
      check('alpha: the old URL was not stored — only its redirect target', !dA.some((d) => d.url?.endsWith('/old-page')));
      check('alpha: the JavaScript-only page produced no empty document', !dA.some((d) => d.url?.endsWith('/spa')));
      const logTxt = JSON.stringify(jA?.log ?? []);
      check('alpha: the JS limitation is reported honestly in the job log', /JavaScript/i.test(logTxt), logTxt.slice(0, 200));
      check('alpha: off-domain links/sitemap entries were ignored and never requested', !fixtures.log.some((l) => l.host === 'beta'));
      check('alpha: robots-disallowed /private/vault was never requested or indexed', !fixtures.log.some((l) => l.host === 'alpha' && l.path.startsWith('/private')) && !dA.some((d) => /vault/i.test(d.url ?? '')));
      check('alpha: the robots.txt file itself was fetched (compliance, not luck)', fixtures.log.some((l) => l.host === 'alpha' && l.path === '/robots.txt'));
      const cA = dA.flatMap((d) => d.chunks);
      check('alpha: PostgreSQL chunks == Qdrant points', (await pointsFor(dA.map((d) => d.id))) === cA.length && cA.every((c) => !!c.vectorId), `${cA.length}`);
      check('alpha: every vector is tagged with the alpha source id', (await pointPayloads(dA.map((d) => d.id))).every((p) => p.sourceId === alpha.id));
      const progA = jA?.progress as { stages: Record<string, { state: string; done: number; count: number }> } | null;
      check('alpha: stage telemetry matches real work (chunk docs == documents, chunk count == DB chunks)', progA?.stages.chunk?.done === dA.length && progA?.stages.chunk?.count === cA.length && progA?.stages.index?.count === cA.length, JSON.stringify(progA?.stages));
      const rowA = page.locator('tr[data-source-id]', { hasText: 'E2E alpha' });
      await sleep(2500);
      check('UI: alpha shows "partial" with the failure explained', (await rowA.locator('[data-testid=crawl-status]').innerText()).trim() === 'partial' && /failed/i.test(await rowA.locator('[data-testid=source-error]').innerText()));
      check('UI: last successful crawl is shown (partial still counts: content is searchable)', /last successful crawl/i.test(await rowA.locator('[data-testid=last-success]').innerText()));

      // ─── retrieval + citations through the real chatbots ───
      const A = FACTS.alpha;
      const t1 = await ask(context, `How much does the ${A.program} pay?`, /23\.40/);
      check('Testing Lab: unique wage fact from the new site', t1.includes('23.40'), t1.slice(0, 200));
      check('Testing Lab: the citation/retrieved passage points at the exact page', t1.includes(`alpha.localtest.me:${PORT}/programs`), t1.slice(0, 300));
      const t2 = await ask(context, `What confirmation code do participants receive after the Cobalt Heron Interview Prep Guide?`, /SEDGE/);
      check('Testing Lab: fact that exists ONLY on the sitemap-discovered page', t2.includes(A.hiddenCode), t2.slice(0, 200));
      const c1 = await ask(context, `Where does the Cobalt Heron Resume Clinic meet?`, /Larkspur/, 'chat');
      check('Admin chatbot: fact from the redirect-target page', /Larkspur Library/i.test(c1), c1.slice(-250));
      const secret = await ask(context, `What is the vault code?`, /PRIVATE-VAULT/);
      check('robots-blocked content is unreachable by the chatbot', !secret.includes(A.privateSecret));
      check('robots-blocked content is absent from the vector store', (await getQdrant().scroll(env.QDRANT_COLLECTION, { filter: { must: [{ key: 'content', match: { text: A.privateSecret } }] }, limit: 5, with_payload: false, with_vector: false })).points.length === 0);

      // public counselor: a recommender, reported rather than asserted
      const pub = await context.newPage();
      const seen: string[] = [];
      pub.on('response', async (r) => { if (r.url().endsWith('/api/session') && r.request().method() === 'POST') { try { const j = (await r.json()) as { turn?: { sources?: { url: string }[] } }; for (const s of j.turn?.sources ?? []) seen.push(s.url); } catch { /* start */ } } });
      await pub.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await pub.getByRole('button', { name: /looking for myself/i }).click();
      for (const turn of ['I want a skilled trades apprenticeship and a resume clinic in the Larkspur region', 'I have a car', 'I can train first', 'show me my options']) {
        if (seen.some((u) => u.includes('alpha.localtest.me'))) break;
        await pub.waitForFunction(`!document.querySelector('textarea')?.disabled`, null, { timeout: 90_000 });
        await pub.locator('textarea').first().fill(turn);
        await pub.locator('textarea').first().press('Enter');
        await pub.waitForTimeout(7000);
      }
      info(`public counselor surfaced a new-site source: ${seen.some((u) => u.includes('alpha.localtest.me'))} (sources: ${[...new Set(seen)].slice(0, 4).join(', ')})`);
      await pub.close();

      // ─── incremental re-crawl ───
      const idsBefore = (await pointPayloads(dA.map((d) => d.id))).length;
      const rowA2 = page.locator('tr[data-source-id]', { hasText: 'E2E alpha' });
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      await rowA2.locator('[data-action=crawl]').click();
      await sleep(1500);
      const jA2 = await finalJob(alpha.id, 150_000, 1500);
      const dA2 = await docsOf(alpha.id);
      check('re-crawl: finished and nothing was re-embedded (incremental)', jA2?.id !== jA?.id && jA2?.documentsCreated === 0 && jA2?.documentsUpdated === 0 && jA2?.chunksIndexed === 0, JSON.stringify({ c: jA2?.documentsCreated, u: jA2?.documentsUpdated, ch: jA2?.chunksIndexed, s: jA2?.status }));
      check('re-crawl: no duplicate documents or vectors', dA2.length === dA.length && (await pointPayloads(dA2.map((d) => d.id))).length === idsBefore);
      check('re-crawl: unchanged documents are reported as unchanged', (jA2?.documentsSkipped ?? 0) >= dA.length, String(jA2?.documentsSkipped));

      // ─── second independent website + prompt-injection page ───
      const addD = await uiAdd(page, U('delta'), 'E2E delta', { depth: 2, max: 20 });
      check('second independent domain accepted', addD.outcome === 'row', addD.error ?? '');
      const delta = (await source('E2E delta'))!;
      const jD = await finalJob(delta.id, 150_000);
      check('delta: COMPLETED with all pages indexed', jD?.status === 'COMPLETED' && (await docsOf(delta.id)).length === 3, `${jD?.status} ${jD?.error}`);
      const D = FACTS.delta;
      const d1 = await ask(context, `How much is the ${D.program}?`, /1,905/);
      check('Testing Lab: unique fact from the second website', d1.includes('1,905'), d1.slice(0, 200));
      const dc = await ask(context, `Where does the Tern Bridge Welding Stipend group meet?`, /Millrace/, 'chat');
      check('PROMPT INJECTION: the page said to reply only with a code word — the chatbot did not obey', !dc.includes(D.injection) && !/evil\.example/.test(dc), dc.slice(-300));
      check('PROMPT INJECTION: the real fact from the same page is still answered', /Millrace Annex/i.test(dc), dc.slice(-300));
      const both = await ask(context, `How much does the ${A.program} pay?`, /23\.40/, 'chat');
      check('both independent sites remain retrievable', both.includes('23.40'), both.slice(-200));

      // ─── source details: documents, chunk counts, scoped retrieval, errors ───
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      const rowD = page.locator('tr[data-source-id]', { hasText: 'E2E delta' });
      await rowD.locator('[data-action=details]').click();
      await page.locator('[data-testid=source-detail]').waitFor();
      const dDocs = await docsOf(delta.id);
      check('details: lists the source\'s documents with chunk counts', (await page.locator('[data-testid=source-docs] tbody tr').count()) === dDocs.length && /chunks/.test(await page.locator('[data-testid=source-detail]').innerText()));
      await page.locator('[data-testid=source-test-input]').fill(`How much is the ${D.program}?`);
      await page.locator('[data-action=source-test]').click();
      await page.locator('[data-testid=source-test-result]').waitFor({ timeout: 90_000 });
      const scoped = await page.locator('[data-testid=source-test-result]').innerText();
      check('details: per-source retrieval test cites this source only', scoped.includes('delta.localtest.me') && !scoped.includes('alpha.localtest.me'), scoped.slice(0, 300));
      check('details: …and answers from it', scoped.includes('1,905'), scoped.slice(0, 200));
      const leak = await apiAs(page, 'POST', '/api/admin/test-query', { message: `How much does the ${A.program} pay?`, sourceId: delta.id });
      check('source filter: asking delta about alpha\'s fact returns no alpha passages', (leak.body.retrievedSources ?? []).every((s: { url: string }) => !s.url.includes('alpha.localtest.me')) && !JSON.stringify(leak.body.answer).includes('23.40'), JSON.stringify(leak.body.retrievedSources?.map((s: { url: string }) => s.url)));
      await rowD.locator('[data-action=details]').click();
      const rowA3 = page.locator('tr[data-source-id]', { hasText: 'E2E alpha' });
      await rowA3.locator('[data-action=details]').click();
      await page.locator('[data-testid=source-detail]').waitFor();
      const detailTxt = await page.locator('[data-testid=source-detail]').innerText();
      check('details: errors and issues from crawls are visible', /404/.test(detailTxt) && /JavaScript/i.test(detailTxt), detailTxt.slice(0, 400));
      await rowA3.locator('[data-action=details]').click();

      // ─── pause / resume ───
      await rowA3.locator('[data-action=toggle]').click();
      await page.waitForFunction(`document.querySelector('tr[data-source-id="${alpha.id}"] [data-testid=source-status]')?.textContent.trim() === 'paused'`);
      check('pause: crawling is disabled', await rowA3.locator('[data-action=crawl]').isDisabled());
      const pausedTry = await apiAs(page, 'POST', '/api/admin/ingestion', { type: 'CRAWL', sourceId: alpha.id });
      check('pause: the API refuses to crawl a paused source', pausedTry.status === 400 && /paused/i.test(pausedTry.body?.error ?? ''));
      const stillThere = await retrieve({ intent: 'general_info', confidence: 0.9, rewrittenQuery: `${A.program} wage`, keywords: [A.program], profileUpdates: {}, missingInfo: null, isMultiPart: false, subQuestions: [] } as never, {} as never, { sourceIds: [alpha.id] });
      check('pause: policy — content already indexed stays searchable', stillThere.sources.length > 0);
      await rowA3.locator('[data-action=toggle]').click();
      await page.waitForFunction(`document.querySelector('tr[data-source-id="${alpha.id}"] [data-testid=source-status]')?.textContent.trim() === 'enabled'`);

      // ─── robots-blocked site ───
      const addB = await uiAdd(page, U('beta'), 'E2E robots blocked', { depth: 2, max: 10 });
      const beta = (await source('E2E robots blocked'))!;
      const jB = await finalJob(beta.id, 90_000);
      check('robots-blocked site: registered, then FAILED with the real reason', addB.outcome === 'row' && jB?.status === 'FAILED' && /robots\.txt/i.test(jB?.error ?? ''), `${jB?.status} ${jB?.error}`);
      check('robots-blocked site: only robots.txt was ever requested', fixtures.log.filter((l) => l.host === 'beta').every((l) => l.path === '/robots.txt') && fixtures.log.some((l) => l.host === 'beta'));
      check('robots-blocked site: nothing indexed, not shown as ready', (await docsOf(beta.id)).length === 0);

      // ─── no relevant content ───
      await uiAdd(page, U('gamma'), 'E2E no content', { depth: 2, max: 10 });
      const gamma = (await source('E2E no content'))!;
      const jG = await finalJob(gamma.id, 90_000);
      check('no-content site: FAILED (saved ≠ ingested) with an explanation', jG?.status === 'FAILED' && /No indexable content/i.test(jG?.error ?? ''), `${jG?.status} ${jG?.error}`);
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      const rowG = page.locator('tr[data-source-id]', { hasText: 'E2E no content' });
      check('no-content site: UI shows failed · not ready · no successful crawl', (await rowG.locator('[data-testid=crawl-status]').innerText()).trim() === 'failed' && (await rowG.locator('[data-testid=retrieval-state]').innerText()).trim() === 'not ready' && /no successful crawl/i.test(await rowG.locator('[data-testid=last-success]').innerText()));

      // ─── redirect to another domain ───
      await uiAdd(page, U('redir'), 'E2E redirects away', { depth: 1, max: 5 });
      const redir = (await source('E2E redirects away'))!;
      const jR = await finalJob(redir.id, 90_000);
      check('cross-domain redirect: FAILED, scope violation reported', jR?.status === 'FAILED' && /scope/i.test(`${jR?.error} ${JSON.stringify(jR?.log)}`), `${jR?.status} ${jR?.error}`);
      check('cross-domain redirect: the other domain was never fetched', !fixtures.log.some((l) => l.host === 'beta' && l.path !== '/robots.txt'));

      // ─── failed network request ───
      await uiAdd(page, U('down'), 'E2E network down', { depth: 1, max: 5 });
      const down = (await source('E2E network down'))!;
      const jN = await finalJob(down.id, 120_000, 9000); // wait out the queue's retry too
      check('network failure: FAILED with a readable cause', jN?.status === 'FAILED' && /robots\.txt|socket|ECONNRESET|hang up|network/i.test(jN?.error ?? ''), `${jN?.status} ${jN?.error}`);

      // ─── cancellation ───
      await uiAdd(page, U('big'), 'E2E cancel me', { depth: 2, max: 40 });
      const big = (await source('E2E cancel me'))!;
      let sawRunning = false;
      for (let i = 0; i < 80 && !sawRunning; i++) { const j = await prisma.ingestionJob.findFirst({ where: { sourceId: big.id }, orderBy: { createdAt: 'desc' } }); sawRunning = j?.status === 'RUNNING' && j.pagesProcessed >= 2; if (!sawRunning) await sleep(400); }
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      const rowBig = page.locator('tr[data-source-id]', { hasText: 'E2E cancel me' });
      await rowBig.locator('[data-action=cancel]').click();
      const jC = await finalJob(big.id, 60_000, 3000);
      check('cancel: the running crawl was stopped from the UI', sawRunning && jC?.status === 'CANCELLED' && jC.pagesProcessed < 41, `${jC?.status} pages=${jC?.pagesProcessed}`);

      // ─── retention policy ───
      await page.goto(`${BASE}/admin/crawler`, { waitUntil: 'networkidle' });
      const rowDel = page.locator('tr[data-source-id]', { hasText: 'E2E delta' });
      const dIds = (await docsOf(delta.id)).map((d) => d.id);
      await rowDel.locator('[data-action=remove]').click();
      await page.locator('[data-action=remove-archive]').click();
      await page.waitForFunction(`!document.querySelector('tr[data-source-id="${delta.id}"]')`, null, { timeout: 30_000 });
      const afterDocs = await prisma.document.findMany({ where: { id: { in: dIds } }, include: { chunks: true } });
      check('remove (take out of search): documents ARCHIVED, chunks and vectors gone, history kept', afterDocs.length === dIds.length && afterDocs.every((d) => d.status === 'ARCHIVED' && d.chunks.length === 0) && (await pointsFor(dIds)) === 0);
      const gone = await ask(context, `How much is the ${D.program}?`, /1,905/);
      check('remove: the chatbot can no longer retrieve the removed source', !gone.includes('1,905'), gone.slice(0, 200));
      check('remove: the other source is untouched', (await pointsFor(dA2.map((d) => d.id))) === cA.length);
    }
    check('no unexpected browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } catch (e) {
    fail++;
    console.log('FAIL  script error →', String(e).slice(0, 500));
  } finally {
    // ─────────── cleanup through the product's own endpoints ───────────
    try {
      for (const label of LABELS) await removeViaApi(page, label);
      await prisma.ingestionJob.deleteMany({ where: { sourceId: null, type: 'CRAWL', createdAt: { gt: new Date(Date.now() - 60 * 60_000) } } });
      for (const d of await prisma.document.findMany({ where: { OR: [{ url: { contains: 'localtest.me' } }, { url: { contains: 'iana.org' } }] }, select: { id: true } })) await apiAs(page, 'DELETE', `/api/admin/documents/${d.id}?hard=true`);
    } catch (e) { console.log('cleanup error', String(e).slice(0, 200)); }
    const after = { sources: await prisma.knowledgeSource.count(), docs: await prisma.document.count(), chunks: await prisma.documentChunk.count(), jobs: await prisma.ingestionJob.count() };
    check('cleanup restored sources, documents, chunks and jobs exactly', JSON.stringify(after) === JSON.stringify(base), `${JSON.stringify(after)} vs ${JSON.stringify(base)}`);
    const goldenAfter = await prisma.document.groupBy({ by: ['sourceId'], _count: true });
    check('the original Golden Sierra sources keep exactly their documents', JSON.stringify(goldenAfter.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)))) === JSON.stringify(sourceDocBaseline.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)))));
    await fixtures?.close();
    await browser.close();
    await prisma.$disconnect();
    console.log(`\nPHASE ${PHASE}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
