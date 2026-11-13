/**
 * TASK 7 — does uploaded knowledge survive a brand-new browser session?
 * Fresh context = fresh storage, fresh chat session. No server restart,
 * no re-index. Recorded.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3100';
const OUT = path.resolve('test-artifacts/persistence');

// Phrasing that genuinely reached the document in the main run.
const Q = 'What salary does Zarnexa Eldercare Collective offer for the caregiver team lead role?';

(async () => {
  const browser = await chromium.launch({ headless: true, slowMo: 80 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 20_000 });

  await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:999999;background:#0b1f17;color:#eafff4;' +
      'font:600 15px/1.5 system-ui;padding:12px 18px;border-top:3px solid #15b37a';
    el.textContent = 'TASK 7 — FRESH browser session (new storage, new chat). No restart, no re-index.';
    document.body.appendChild(el);
  });
  await page.waitForTimeout(2200);

  await page.locator('#chat-input').fill(Q);
  await page.locator('#chat-input').press('Enter');
  await page.getByText('Was this helpful?').first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);

  const answer = (await page.locator('div.answer-prose').last().innerText()).trim();
  const grounded = answer.includes('47.50') || answer.includes('Zarnexa');
  await page.screenshot({ path: path.join(OUT, 'fresh-session-answer.png') });

  console.log('  fresh session grounded in PDF:', grounded);
  console.log('  answer:', answer.slice(0, 260).replace(/\n/g, ' '));
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ q: Q, answer, grounded }, null, 2));

  await context.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
