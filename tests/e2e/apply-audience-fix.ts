/**
 * Recorded demonstration: fixing the audience misclassification, live.
 *
 * Three acts, all against the running application:
 *   1. BEFORE — ask as a job seeker, show the PDFs are not retrieved
 *   2. FIX    — PATCH both documents via the admin API with reindex
 *   3. AFTER  — ask the identical question, show the PDFs are now retrieved
 *
 * Evidence comes from the RetrievalLog table, not from string-matching the
 * answer text — an earlier run showed the model echoing question terms while
 * having retrieved nothing, so answer text alone proves nothing.
 *
 *   npx tsx tests/e2e/apply-audience-fix.ts
 */
import { chromium, type Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:3100';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const OUT = path.resolve('test-artifacts/fix');

/** The question that failed before: plainly a job seeker. */
const JOB_SEEKER_Q =
  'I am unemployed and looking for caregiver work. What job openings are in the knowledge base?';

const prisma = new PrismaClient();
const results: Record<string, unknown> = {};

async function caption(page: Page, text: string, ms = 2200, tone: 'info' | 'bad' | 'good' = 'info') {
  const colour = tone === 'bad' ? '#b3261e' : tone === 'good' ? '#15b37a' : '#15b37a';
  const bg = tone === 'bad' ? '#2a0f0d' : '#0b1f17';
  await page.evaluate(
    ({ t, c, b }) => {
      let el = document.getElementById('__qa_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__qa_caption';
        document.body.appendChild(el);
      }
      el.style.cssText =
        `position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:${b};` +
        `color:#eafff4;font:600 15px/1.5 ui-sans-serif,system-ui;padding:12px 18px;` +
        `border-top:3px solid ${c};letter-spacing:.2px`;
      el.textContent = t;
    },
    { t: text, c: colour, b: bg },
  );
  await page.waitForTimeout(ms);
}

/** Ground truth: how many chunks of our two PDFs did retrieval actually return? */
async function pdfChunksInLastTurn(): Promise<{ qa: number; scrape: number; total: number; intent: string }> {
  const [row] = await prisma.$queryRawUnsafe<
    { qa: bigint; scrape: bigint; total: number; intent: string }[]
  >(`
    select
      (select count(*) from jsonb_array_elements(results) e where e->>'title' like 'QA-Test%') as qa,
      (select count(*) from jsonb_array_elements(results) e where e->>'title' = 'Scrapedata') as scrape,
      jsonb_array_length(results) as total,
      coalesce(intent,'?') as intent
    from "RetrievalLog" order by "createdAt" desc limit 1
  `);
  return { qa: Number(row?.qa ?? 0), scrape: Number(row?.scrape ?? 0), total: row?.total ?? 0, intent: row?.intent ?? '?' };
}

async function ask(page: Page, q: string, label: string) {
  await page.locator('#chat-input').fill(q);
  await page.locator('#chat-input').press('Enter');
  const count = await page.getByText('Was this helpful?').count();
  await page.getByText('Was this helpful?').nth(count).waitFor({ timeout: 120_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const answer = (await page.locator('div.answer-prose').last().innerText()).trim();
  const truth = await pdfChunksInLastTurn();
  console.log(`  [${label}] intent=${truth.intent} qaChunks=${truth.qa} scrapeChunks=${truth.scrape} of ${truth.total}`);
  return { answer, truth };
}

(async () => {
  const browser = await chromium.launch({ headless: true, slowMo: 90 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  try {
    // ── ACT 1: BEFORE ────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 20_000 });
    await caption(page, 'ACT 1 — BEFORE THE FIX. Both PDFs are classified audience=employer.', 2800, 'bad');
    await caption(page, `Asking as a job seeker: "${JOB_SEEKER_Q.slice(0, 70)}…"`, 2000, 'bad');

    const before = await ask(page, JOB_SEEKER_Q, 'BEFORE');
    results.before = before.truth;
    await caption(
      page,
      `BEFORE — retrieved ${before.truth.qa + before.truth.scrape} PDF chunks of ${before.truth.total}. The uploaded documents are filtered out.`,
      3200,
      'bad',
    );
    await page.screenshot({ path: path.join(OUT, '1-before.png') });

    // ── ACT 2: THE FIX ───────────────────────────────────────────────
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill(ADMIN_EMAIL);
    await page.locator('#password').fill(ADMIN_PASSWORD); // masked on screen
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 20_000 });

    await page.goto(`${BASE}/admin/programs`, { waitUntil: 'networkidle' });
    await caption(page, 'ACT 2 — Signed in as admin. Applying the reclassification via the admin API.', 2800);

    const docs = await prisma.document.findMany({
      where: { OR: [{ title: { contains: 'Scrapedata' } }, { title: { contains: 'QA-Test' } }] },
      select: { id: true, title: true, audience: true, category: true },
    });

    const applied: Record<string, unknown>[] = [];
    for (const doc of docs) {
      await caption(page, `Patching "${doc.title}" → audience: both, category: job_search, reindex: true`, 2000);

      // Runs in the browser, carrying the admin session cookie — the same
      // request the dashboard itself would make.
      const res = await page.evaluate(
        async ({ id }) => {
          const r = await fetch(`/api/admin/documents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audience: 'both', category: 'job_search', reindex: true }),
          });
          return { status: r.status, body: await r.json().catch(() => ({})) };
        },
        { id: doc.id },
      );

      console.log(`  PATCH ${doc.title}: ${res.status} ${JSON.stringify(res.body)}`);
      applied.push({ title: doc.title, was: doc.audience, ...res });
      await caption(page, `✓ ${doc.title}: HTTP ${res.status} — re-indexed ${(res.body as { chunks?: number }).chunks ?? 0} chunks`, 2400, 'good');
    }
    results.applied = applied;
    await page.screenshot({ path: path.join(OUT, '2-fix-applied.png') });

    // ── ACT 3: AFTER ─────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 20_000 });
    await caption(page, 'ACT 3 — AFTER THE FIX. Same question, same wording, fresh conversation.', 2800, 'good');

    const after = await ask(page, JOB_SEEKER_Q, 'AFTER');
    results.after = after.truth;
    results.afterAnswer = after.answer;

    const retrieved = after.truth.qa + after.truth.scrape;
    await caption(
      page,
      `AFTER — retrieved ${retrieved} PDF chunks of ${after.truth.total}. ${retrieved > 0 ? 'The uploaded knowledge is now reachable by job seekers. ✓' : 'Still not retrieved ✗'}`,
      3600,
      retrieved > 0 ? 'good' : 'bad',
    );
    await page.screenshot({ path: path.join(OUT, '3-after.png') });

    console.log(`\n  BEFORE: ${(results.before as { qa: number; scrape: number }).qa + (results.before as { scrape: number }).scrape} PDF chunks`);
    console.log(`  AFTER : ${retrieved} PDF chunks`);
    writeFileSync(path.join(OUT, 'fix-results.json'), JSON.stringify(results, null, 2));
  } finally {
    await context.close();
    await browser.close();
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
