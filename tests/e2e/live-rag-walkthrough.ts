/**
 * Live, recorded end-to-end verification of the upload → index → retrieve path.
 *
 * Drives a real Chromium browser against the running application and records
 * the whole session to WebM. Nothing here is simulated: every assertion is
 * read back from the live UI, and the database/vector checks run separately
 * against the same PostgreSQL and Qdrant instances the app is using.
 *
 * Credential hygiene: the admin password is typed into a password input, which
 * the browser renders as dots, so it never appears in the recording. No API
 * key, connection string or token is printed to the page or the console.
 *
 *   npx tsx tests/e2e/live-rag-walkthrough.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const PDF = path.resolve('test-artifacts/QA-Test-Workforce-Data.pdf');
const OUT = path.resolve('test-artifacts');

/** Unique strings that exist ONLY in the synthetic PDF. */
const ANCHORS = ['GOLDENSIERRA-QA-ANCHOR-8842', 'Zarnexa', 'Quillfeather', 'Marrowind', '47.50'];

type Step = { step: string; detail: string; pass: boolean | null };
const log: Step[] = [];

function record(step: string, detail: string, pass: boolean | null = null) {
  const mark = pass === null ? '·' : pass ? '✓' : '✗';
  console.log(`  ${mark} ${step} — ${detail}`);
  log.push({ step, detail, pass });
}

/** On-screen caption so the recording explains itself without narration. */
async function caption(page: Page, text: string, ms = 1600) {
  await page.evaluate((t) => {
    let el = document.getElementById('__qa_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__qa_caption';
      el.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#0b1f17;' +
        'color:#eafff4;font:600 15px/1.5 ui-sans-serif,system-ui;padding:12px 18px;' +
        'border-top:3px solid #15b37a;letter-spacing:.2px';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await page.waitForTimeout(ms);
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true, slowMo: 90 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  // Surface genuine browser-side failures rather than letting them pass silently.
  page.on('pageerror', (e) => record('browser error', e.message, false));

  try {
    // ── TASK 1: open the app ───────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await caption(page, 'TASK 1 — Golden Sierra Workforce Navigator (local instance under test)', 2200);
    record('open app', `${BASE} title="${await page.title()}"`, true);

    const composer = page.locator('#chat-input');
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    record('chat UI', 'composer visible, session started', true);
    await page.screenshot({ path: path.join(OUT, '01-chat-home.png') });

    // ── TASK 1: admin dashboard ────────────────────────────────────────
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await caption(page, 'TASK 1 — Admin dashboard requires authentication', 1600);
    const signInVisible = await page.getByText('Admin sign in').isVisible();
    record('admin gate', signInVisible ? 'login form shown when signed out' : 'NO login form', signInVisible);

    await page.locator('#email').fill(ADMIN_EMAIL);
    // Password field — rendered as dots, so the value never appears on video.
    await page.locator('#password').fill(ADMIN_PASSWORD);
    await caption(page, 'Signing in (password field is masked — no credentials visible)', 1200);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 20_000 });
    await caption(page, 'TASK 1 — Signed in: knowledge base health and usage', 2200);
    record('admin login', 'authenticated, Overview rendered', true);
    await page.screenshot({ path: path.join(OUT, '02-admin-overview.png') });

    // Read the live counters straight off the dashboard.
    const statFor = async (label: string) => {
      const card = page.locator('div').filter({ hasText: new RegExp(`^${label}`) }).last();
      return (await card.innerText()).replace(/\s+/g, ' ').trim();
    };
    record('dashboard stats', await statFor('Documents indexed'), true);
    record('dashboard stats', await statFor('Vectors in Qdrant'), true);

    // ── TASK 1: knowledge sources ──────────────────────────────────────
    await page.goto(`${BASE}/admin/sources`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Knowledge sources' }).waitFor({ timeout: 20_000 });
    await caption(page, 'TASK 1 — Knowledge Base Management: existing indexed sources', 2400);
    await page.screenshot({ path: path.join(OUT, '03-knowledge-sources.png') });

    const sourcesText = await page.locator('main').innerText();
    const sourceCount = (sourcesText.match(/documents · depth/g) ?? []).length;
    record('knowledge sources', `${sourceCount} configured sources listed with document counts`, sourceCount > 0);

    const uploadVisible = await page.getByText('Upload a PDF').isVisible();
    record('upload UI', uploadVisible ? 'upload control accessible' : 'upload control MISSING', uploadVisible);

    // ── TASK 2: upload ─────────────────────────────────────────────────
    await caption(page, 'TASK 2 — Uploading synthetic QA PDF (fictitious data, clearly labelled)', 2400);
    const uploadCard = page.locator('div').filter({ hasText: 'Upload a PDF' }).last();
    await uploadCard.scrollIntoViewIfNeeded();

    const started = Date.now();
    await page.setInputFiles('input[type="file"]', PDF);
    record('upload', `file submitted: ${path.basename(PDF)} (${readFileSync(PDF).length} bytes)`, true);
    await caption(page, 'TASK 2/3 — Extraction → chunking → embedding → Qdrant (live, no manual step)', 2000);

    // Wait for the UI to report the real outcome, not a spinner.
    const result = page.locator('text=/chunks indexed|Could not process/i').first();
    await result.waitFor({ timeout: 180_000 });
    const elapsed = Date.now() - started;
    const resultText = (await result.innerText()).trim();

    record('upload result (UI)', `"${resultText}" in ${(elapsed / 1000).toFixed(1)}s`, /chunks indexed/i.test(resultText));
    await page.screenshot({ path: path.join(OUT, '04-upload-result.png') });
    await caption(page, `TASK 2 — UI reports: ${resultText}`, 2600);

    const chunkMatch = /(\d+)\s+chunks indexed/i.exec(resultText);
    const uiChunks = chunkMatch ? Number(chunkMatch[1]) : 0;

    // ── TASK 6: retrieval through the real chatbot ─────────────────────
    const questions = [
      'What is the QA verification anchor token in the uploaded knowledge base?',
      'What salary does Zarnexa Eldercare Collective offer for the caregiver team lead role?',
      'I am unemployed and looking for caregiver work. What opportunities are in the knowledge base?',
      'How do I apply for the Quillfeather Diagnostics phlebotomy position?',
    ];

    const answers: { q: string; a: string; grounded: boolean; cites: string[]; hit: string[] }[] = [];

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await caption(page, 'TASK 6 — Querying the chatbot with facts that exist ONLY in the PDF', 2600);

    for (const [i, q] of questions.entries()) {
      await page.locator('#chat-input').fill(q);
      await caption(page, `Q${i + 1}: ${q}`, 1400);
      await page.locator('#chat-input').press('Enter');

      // The assistant bubble is complete once the feedback control appears.
      await page.getByText('Was this helpful?').nth(i).waitFor({ timeout: 120_000 });
      await page.waitForTimeout(600);

      const bubbles = page.locator('div.answer-prose');
      const answer = (await bubbles.nth(i).innerText()).trim();

      // Expand the citation list so sources are visible on video.
      const srcToggle = page.locator('button', { hasText: /source/i }).nth(i);
      let cites: string[] = [];
      if (await srcToggle.count()) {
        await srcToggle.click().catch(() => undefined);
        await page.waitForTimeout(500);
        cites = await page
          .locator('li a[target="_blank"], li span')
          .allInnerTexts()
          .then((t) => t.filter((x) => /QA-Test|Scrapedata|goldensierra/i.test(x)).slice(0, 4));
      }

      const hit = ANCHORS.filter((a) => answer.includes(a));
      answers.push({ q, a: answer, grounded: hit.length > 0, cites, hit });
      record(`Q${i + 1}`, `anchors found: ${hit.length ? hit.join(', ') : 'NONE'}`, hit.length > 0);

      await caption(page, `A${i + 1}: ${hit.length ? 'grounded in PDF ✓' : 'PDF content NOT retrieved ✗'}`, 2200);
      await page.screenshot({ path: path.join(OUT, `05-answer-${i + 1}.png`) });
    }

    // ── TASK 7: availability without restart / after reload ────────────
    await caption(page, 'TASK 7 — Reloading the browser (no server restart, no re-index)', 2000);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 20_000 });

    const reloadQ = 'What is the QA verification anchor token?';
    await page.locator('#chat-input').fill(reloadQ);
    await page.locator('#chat-input').press('Enter');
    await page.getByText('Was this helpful?').first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(600);
    const afterReload = (await page.locator('div.answer-prose').last().innerText()).trim();
    const reloadHit = ANCHORS.filter((a) => afterReload.includes(a));
    record('after browser reload', reloadHit.length ? `retrieved: ${reloadHit.join(', ')}` : 'NOT retrieved', reloadHit.length > 0);
    await caption(page, `TASK 7 — After reload: ${reloadHit.length ? 'knowledge still retrievable ✓' : 'not retrievable ✗'}`, 2600);
    await page.screenshot({ path: path.join(OUT, '06-after-reload.png') });

    writeFileSync(
      path.join(OUT, 'walkthrough-results.json'),
      JSON.stringify({ base: BASE, uiChunks, elapsedMs: elapsed, resultText, log, answers, reloadHit }, null, 2),
    );

    await caption(page, 'Walkthrough complete — see GOLDEN_SIERRA_RAG_LIVE_TEST_REPORT.md', 2600);
  } finally {
    await context.close(); // flushes the video to disk
    await browser.close();
  }
}

main().catch((err) => {
  console.error('WALKTHROUGH FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
