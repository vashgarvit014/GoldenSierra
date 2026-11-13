/**
 * Verification of the audience fix in REAL Google Chrome, headed and visible.
 *
 * Opens an actual Chrome window on screen and drives it slowly enough to
 * follow. Every claim is checked against the RetrievalLog table — what the
 * pipeline really retrieved — because answer text alone can echo the question.
 *
 *   npx tsx tests/e2e/chrome-verify-fix.ts
 */
import { chromium, type Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:3100';
const OUT = path.resolve('test-artifacts/chrome');
const prisma = new PrismaClient();

/** Questions a job seeker would actually ask — the case that used to fail. */
const QUESTIONS = [
  'I am unemployed and looking for caregiver work. What job openings are in the knowledge base?',
  'What caregiver jobs are available in Placer County and what do they pay?',
  'I am looking for work. What salary does Zarnexa Eldercare Collective offer?',
];

async function caption(page: Page, text: string, ms: number, tone: 'info' | 'good' | 'bad' = 'info') {
  const c = tone === 'bad' ? '#b3261e' : '#15b37a';
  const b = tone === 'bad' ? '#2a0f0d' : '#0b1f17';
  await page.evaluate(
    ({ t, c, b }) => {
      let el = document.getElementById('__qa_cap');
      if (!el) {
        el = document.createElement('div');
        el.id = '__qa_cap';
        document.body.appendChild(el);
      }
      el.style.cssText =
        `position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:${b};color:#eafff4;` +
        `font:600 16px/1.5 ui-sans-serif,system-ui;padding:14px 20px;border-top:3px solid ${c}`;
      el.textContent = t;
    },
    { t: text, c, b },
  );
  await page.waitForTimeout(ms);
}

/** Ground truth for the most recent turn. */
async function lastTurn() {
  const [r] = await prisma.$queryRawUnsafe<
    { pdf: bigint; total: number; intent: string; titles: string }[]
  >(`
    select
      (select count(*) from jsonb_array_elements(results) e
        where e->>'title' in ('Scrapedata','QA-Test-Workforce-Data')) as pdf,
      jsonb_array_length(results) as total,
      coalesce(intent,'?') as intent,
      coalesce((select string_agg(distinct e->>'title', ', ')
        from jsonb_array_elements(results) e), '') as titles
    from "RetrievalLog" order by "createdAt" desc limit 1
  `);
  return { pdf: Number(r?.pdf ?? 0), total: r?.total ?? 0, intent: r?.intent ?? '?', titles: r?.titles ?? '' };
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', // real Google Chrome, not bundled Chromium
    headless: false, // visible window
    slowMo: 220, // slow enough to watch
    args: ['--window-size=1440,960', '--window-position=60,40'],
  });
  const context = await browser.newContext({
    viewport: { width: 1420, height: 880 },
    recordVideo: { dir: OUT, size: { width: 1420, height: 880 } },
  });
  const page = await context.newPage();
  const findings: Record<string, unknown>[] = [];

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 30_000 });

    await caption(page, `Real Google Chrome ${browser.version()} — verifying the audience fix`, 3000);
    await caption(page, 'Both PDFs were audience=employer and invisible to job seekers. Now: audience=both.', 3400);

    for (const [i, q] of QUESTIONS.entries()) {
      await caption(page, `Q${i + 1}: ${q}`, 2600);

      await page.locator('#chat-input').fill(q);
      await page.locator('#chat-input').press('Enter');

      await page.getByText('Was this helpful?').nth(i).waitFor({ timeout: 150_000 });
      await page.waitForTimeout(1500);

      const truth = await lastTurn();
      const answer = (await page.locator('div.answer-prose').nth(i).innerText()).trim();

      // Open the citation list so sources are visible on screen.
      const toggle = page.locator('button', { hasText: /source/i }).nth(i);
      if (await toggle.count()) {
        await toggle.click().catch(() => undefined);
        await page.waitForTimeout(1200);
      }

      const ok = truth.pdf > 0;
      console.log(`  Q${i + 1} intent=${truth.intent} pdfChunks=${truth.pdf}/${truth.total}`);
      console.log(`     sources: ${truth.titles}`);
      findings.push({ q, ...truth, ok, answer: answer.slice(0, 400) });

      await caption(
        page,
        ok
          ? `✓ Q${i + 1}: ${truth.pdf} of ${truth.total} retrieved chunks came from the uploaded PDFs (intent=${truth.intent})`
          : `✗ Q${i + 1}: no PDF chunks retrieved (intent=${truth.intent})`,
        3800,
        ok ? 'good' : 'bad',
      );
      await page.screenshot({ path: path.join(OUT, `chrome-q${i + 1}.png`) });
      await page.waitForTimeout(600);
    }

    const passed = findings.filter((f) => f.ok).length;
    await caption(page, `Result: ${passed}/${QUESTIONS.length} job-seeker questions now retrieve the uploaded PDFs.`, 4200, passed > 0 ? 'good' : 'bad');
    writeFileSync(path.join(OUT, 'chrome-results.json'), JSON.stringify({ browser: browser.version(), findings }, null, 2));
    console.log(`\n  ${passed}/${QUESTIONS.length} questions retrieved uploaded PDF content`);
  } finally {
    await context.close();
    await browser.close();
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
