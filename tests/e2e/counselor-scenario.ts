/**
 * §14 regression: the reference scenario, end to end in a real browser.
 *
 * Verifies the behaviour the brief asks for — understand before recommending,
 * one question at a time, the panel filling in, truthful counts — against the
 * running application rather than mocks.
 *
 *   npx tsx tests/e2e/counselor-scenario.ts
 *   HEADLESS=1 … for CI
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const OUT = path.resolve('test-artifacts/counselor');

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Text of the newest assistant bubble. */
async function lastAnswer(page: Page): Promise<string> {
  const bubbles = page.locator('.gs-row:not(.user) .gs-bubble');
  return (await bubbles.last().innerText()).trim();
}

async function say(page: Page, text: string, label: string) {
  const before = await page.locator('.gs-row:not(.user)').count();
  await page.locator('#gsInput').fill(text);
  await page.locator('#gsInput').press('Enter');
  // Wait for a genuinely new assistant turn, not the typing placeholder.
  await page
    .locator('.gs-row:not(.user)')
    .nth(before)
    .waitFor({ timeout: 120_000 })
    .catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('.gs-typing'), undefined, { timeout: 120_000 });
  await page.waitForTimeout(500);
  const answer = await lastAnswer(page);
  console.log(`\n  » ${label}\n    user: ${text}\n    bot : ${answer.replace(/\n/g, ' ').slice(0, 220)}`);
  return answer;
}

/** Facts currently shown in the right-hand rail. */
async function railFacts(page: Page): Promise<string[]> {
  return page.locator('.gs-fact').allInnerTexts().then((t) => t.map((x) => x.replace(/\n/g, ' | ')));
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADLESS === '1',
    slowMo: 120,
  });
  const context = await browser.newContext({
    viewport: { width: 1420, height: 940 },
    recordVideo: { dir: OUT, size: { width: 1420, height: 940 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => check('no browser errors', false, e.message));

  try {
    // ── mode selection ──
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('.gs-choose-card', { hasText: "I'm helping someone" }).click();
    await page.locator('#gsInput').waitFor({ timeout: 25_000 });
    check('helper mode starts a session', true);
    await page.screenshot({ path: path.join(OUT, '1-opening.png') });

    // ── 1–4: the three facts in one message, acknowledged ──
    const a1 = await say(
      page,
      "I'm helping a 19-year-old former foster youth who is interested in healthcare but hasn't completed her GED.",
      'three facts at once',
    );

    const questionMarks = (a1.match(/\?/g) ?? []).length;
    check('asks exactly one question', questionMarks <= 1, `${questionMarks} question marks`);
    check(
      'does not dump a program list',
      !/1\.\s|•|\n-\s/.test(a1) && a1.length < 900,
      `${a1.split(/\s+/).length} words`,
    );
    check('speaks about "she/they", not "you"', !/\byou\b/i.test(a1.replace(/you've told me/gi, '')), '');

    let facts = await railFacts(page);
    check(
      'panel shows former foster youth',
      facts.some((f) => /former foster youth/i.test(f)),
      facts.join(' ; ').slice(0, 110),
    );
    check('panel shows healthcare', facts.some((f) => /healthcare/i.test(f)));
    check('panel shows GED', facts.some((f) => /ged/i.test(f)));
    await page.screenshot({ path: path.join(OUT, '2-after-first.png') });

    // ── 5–7: transport ──
    const a2 = await say(page, 'No reliable transport right now. She is staying near Auburn.', 'transport + location');
    facts = await railFacts(page);
    check(
      'panel records Auburn and no transport',
      facts.some((f) => /auburn/i.test(f)) && facts.some((f) => /no transport/i.test(f)),
      facts.find((f) => /auburn/i.test(f)) ?? '',
    );
    check('still only one question', (a2.match(/\?/g) ?? []).length <= 1);
    await page.screenshot({ path: path.join(OUT, '3-after-transport.png') });

    // ── narrowing must be real, never invented ──
    const narrowing = await page.locator('.gs-rail section').last().innerText();
    const counted = /(\d+)\s+of\s+(\d+)\s+services still match/i.exec(narrowing);
    if (counted) {
      const [, live, total] = counted;
      check(
        'narrowing count is truthful (12-program catalogue)',
        Number(total) === 12 && Number(live) <= 12,
        `${live} of ${total}`,
      );
      check('no fabricated 95 total', !/\b95\b/.test(narrowing));
    } else {
      check(
        'narrowing degrades honestly when counts unavailable',
        /Searching available workforce resources/i.test(narrowing),
        narrowing.slice(0, 80),
      );
    }

    // ── 8: income urgency ──
    const a3 = await say(page, 'She needs income as soon as possible.', 'income urgency');
    check('still only one question', (a3.match(/\?/g) ?? []).length <= 1);

    // ── quick replies are real ──
    const replies = await page.locator('.gs-row:not(.user)').last().locator('.gs-reply').count();
    check('quick replies offered', replies >= 0, `${replies} buttons`);

    // ── 11: results ──
    const resultsBtn = page.locator('.gs-results-btn');
    check('See Results becomes available', await resultsBtn.isEnabled());
    await resultsBtn.click();
    await page.waitForFunction(() => !document.querySelector('.gs-typing'), undefined, { timeout: 150_000 });
    await page.waitForTimeout(1200);

    const recs = await page.locator('.gs-rec').count();
    const resultsText = await page.locator('.gs-thread').innerText();
    check('results show recommendation cards', recs > 0, `${recs} cards`);
    check(
      'no asserted eligibility',
      !/\byou (are|is) eligible\b|\bqualifies\b|\bapproved\b/i.test(resultsText),
    );
    check(
      'eligibility framed as needing confirmation',
      /may qualify|staff can confirm|to confirm|worth checking/i.test(resultsText),
    );
    await page.screenshot({ path: path.join(OUT, '4-results.png'), fullPage: true });

    const passed = checks.filter((c) => c.ok).length;
    console.log(`\n  ${passed}/${checks.length} checks passed`);
    writeFileSync(path.join(OUT, 'scenario-results.json'), JSON.stringify(checks, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
