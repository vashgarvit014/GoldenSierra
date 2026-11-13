/**
 * Verifies the ported console in real Chrome: every tab loads real data, and
 * the chat actually streams a grounded answer.
 *
 *   npx tsx tests/e2e/console-verify.ts            # headed
 *   HEADLESS=1 npx tsx tests/e2e/console-verify.ts # CI
 */
import { chromium, type Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const OUT = path.resolve('test-artifacts/console');

const results: { page: string; checks: string[]; ok: boolean }[] = [];

async function tab(page: Page, id: string, label: string, expect: RegExp[]) {
  await page.locator(`.nav button:has-text("${label}")`).first().click();
  await page.waitForTimeout(2200); // let the panel's fetches settle
  const text = await page.locator(`#${id}`).innerText();

  const checks: string[] = [];
  let ok = true;
  for (const re of expect) {
    const hit = re.test(text);
    if (!hit) ok = false;
    checks.push(`${hit ? '✓' : '✗'} ${re.source.slice(0, 48)}`);
  }
  // A page that rendered an error box is a failure regardless of content.
  if (/Request failed|Something went wrong/i.test(text)) {
    ok = false;
    checks.push('✗ page rendered an error');
  }

  results.push({ page: label, checks, ok });
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  for (const c of checks) console.log(`         ${c}`);
  await page.screenshot({ path: path.join(OUT, `${id}.png`) });
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADLESS === '1',
    slowMo: 120,
  });
  const context = await browser.newContext({
    viewport: { width: 1480, height: 940 },
    recordVideo: { dir: OUT, size: { width: 1480, height: 940 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  BROWSER ERROR:', e.message));

  try {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD); // masked on screen
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.brand-name').waitFor({ timeout: 25_000 });
    console.log('  signed in — console shell rendered');

    await tab(page, 'overview', 'Overview', [
      /Knowledge Documents/,
      /Vector Records/,
      /\b40\b/,       // real document count
      /\b389\b/,      // real chunk / vector count
      /System Status/,
    ]);

    await tab(page, 'knowledge', 'Knowledge Base', [
      /Indexed Documents/,
      /Scrapedata/,          // a real row from the database
      /Drop a PDF here/,
    ]);

    await tab(page, 'crawler', 'Website Crawler', [
      /Knowledge Sources/,
      /goldensierra\.com/,
      /Ingestion Jobs/,
    ]);

    await tab(page, 'analytics', 'Analytics', [/Conversations/, /What people ask/]);

    await tab(page, 'settings', 'Settings', [
      /Models and endpoints/,
      /mercury-3/,           // the live configured model
      /bge-small/,
    ]);

    // ── Testing lab: run a real query ───────────────────────────────────
    await page.locator('.nav button:has-text("RAG Testing Lab")').click();
    await page.waitForTimeout(600);
    await page.locator('#testQuery').fill('Are there training scholarships available?');
    await page.locator('#testing button:has-text("Run test")').click();
    await page.locator('#testing >> text=/Retrieved passages/').waitFor({ timeout: 150_000 });
    await page.waitForTimeout(1200);
    const labText = await page.locator('#testing').innerText();
    const labOk = /Retrieved passages \((?!0\))/.test(labText) && /Query analysis/.test(labText);
    results.push({
      page: 'RAG Testing Lab',
      checks: [`${labOk ? '✓' : '✗'} real retrieval with passages`],
      ok: labOk,
    });
    console.log(`\n  ${labOk ? 'PASS' : 'FAIL'}  RAG Testing Lab (live query)`);
    await page.screenshot({ path: path.join(OUT, 'testing.png') });

    // ── Chat: stream a grounded answer ──────────────────────────────────
    await page.locator('.nav button:has-text("AI Workforce Chat")').click();
    await page.locator('#chatInput').waitFor({ timeout: 25_000 });
    await page.locator('#chatInput').fill('Are there training scholarships available?');
    await page.locator('#chatInput').press('Enter');
    await page.locator('#chat >> text=/Was this helpful/').first().waitFor({ timeout: 150_000 });
    await page.waitForTimeout(1500);

    const chatText = await page.locator('#chat').innerText();
    const chatOk = /sources/i.test(chatText) && chatText.length > 400;
    results.push({
      page: 'AI Workforce Chat',
      checks: [
        `${chatOk ? '✓' : '✗'} streamed an answer with sources`,
        `answer length ${chatText.length} chars`,
      ],
      ok: chatOk,
    });
    console.log(`\n  ${chatOk ? 'PASS' : 'FAIL'}  AI Workforce Chat (live stream)`);
    await page.screenshot({ path: path.join(OUT, 'chat.png') });

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n  ${passed}/${results.length} pages verified`);
    writeFileSync(path.join(OUT, 'console-results.json'), JSON.stringify(results, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
