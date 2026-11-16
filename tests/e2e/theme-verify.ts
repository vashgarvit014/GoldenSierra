/**
 * Visual + structural check of the branded theme across the whole product.
 *   HEADLESS=1 npx tsx tests/e2e/theme-verify.ts
 * Reports, per page and width: horizontal overflow, console errors, hydration
 * warnings, undersized tap targets on mobile, and unlabeled form controls.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';
const OUT = path.resolve('test-artifacts/theme/after');
const WIDTHS = [375, 768, 1024, 1440];

type Row = { page: string; width: number; overflow: number; smallTargets: number; unlabeled: number };
const rows: Row[] = [];
const problems: string[] = [];

async function audit(page: Page, name: string, width: number) {
  console.log('  audit', name, width);
  await page.waitForTimeout(500);
  // Plain JS in a string: tsx's transpiler injects helpers that do not exist in the page.
  const r = (await page.evaluate(`(() => {
    const w = ${width};
    const doc = document.documentElement;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
    const visible = (el) => {
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    let small = 0;
    if (w <= 768) {
      for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')) {
        if (!visible(el)) continue;
        const b = el.getBoundingClientRect();
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue; // inline text links are exempt
        if (b.height < 24 || b.width < 24) small++;
      }
    }
    let unlabeled = 0;
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!visible(el)) continue;
      const id = el.getAttribute('id');
      const has = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (id && document.querySelector('label[for="' + id + '"]')) || el.getAttribute('title');
      if (!has) unlabeled++;
    }
    return { overflow, small, unlabeled };
  })()`)) as { overflow: number; small: number; unlabeled: number };
  rows.push({ page: name, width, overflow: r.overflow, smallTargets: r.small, unlabeled: r.unlabeled });
  if (r.overflow > 0) problems.push(`${name} @${width}: horizontal overflow ${r.overflow}px`);
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' }); console.log('browser up');
  const errors: string[] = [];

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width <= 768 ? 812 : 900 }, isMobile: width <= 768, hasTouch: width <= 768 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`@${width} pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !/negative time stamp/.test(t)) errors.push(`@${width} console: ${t.slice(0, 180)}`);
      if (/hydrat/i.test(t)) errors.push(`@${width} HYDRATION: ${t.slice(0, 180)}`);
    });

    // Public
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await audit(page, 'landing', width);
    if (width === 1440 || width === 375) await page.screenshot({ path: `${OUT}/01-landing-${width}.png` });
    await page.getByRole('button', { name: /looking for myself/i }).click();
    await page.locator('#chat-input').waitFor();
    await audit(page, 'chat-welcome', width);
    if (width === 1440 || width === 375) await page.screenshot({ path: `${OUT}/02-chat-welcome-${width}.png` });

    // Admin
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    if (width === 1440 || width === 375) await page.screenshot({ path: `${OUT}/03-admin-login-${width}.png` });
    await audit(page, 'admin-login', width);
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.brand').waitFor({ timeout: 25_000 });
    await page.waitForTimeout(2200);
    await audit(page, 'console-overview', width);
    if (width === 1440 || width === 375) await page.screenshot({ path: `${OUT}/04-admin-overview-${width}.png` });

    for (const [id, label] of [['chat', 'AI Workforce Chat'], ['knowledge', 'Knowledge Base'], ['crawler', 'Website Crawler'], ['testing', 'RAG Testing Lab'], ['analytics', 'Analytics'], ['settings', 'Settings']] as const) {
      if (width <= 700) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.locator(`.nav a:has-text("${label}")`).first().click();
      await page.waitForTimeout(1800);
      await audit(page, `console-${id}`, width);
      if (width === 1440) await page.screenshot({ path: `${OUT}/05-console-${id}-1440.png`, fullPage: id === 'crawler' ? false : false });
      if (width === 375 && (id === 'knowledge' || id === 'chat')) await page.screenshot({ path: `${OUT}/05-console-${id}-375.png` });
    }
    if (width === 375) {
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/06-admin-mobile-nav-375.png` });
      await page.getByRole('button', { name: 'Toggle navigation' }).click().catch(() => undefined);
    }

    for (const p of ['crawler', 'programs', 'testing', 'settings']) {
      await page.goto(`${BASE}/admin/${p}`, { waitUntil: 'networkidle' });
      await audit(page, `admin-${p}`, width);
      if (width === 1440 || (width === 375 && p === 'crawler')) await page.screenshot({ path: `${OUT}/07-admin-${p}-${width}.png` });
    }
    await ctx.close();
  }

  console.log('\npage                    width  overflow  smallTargets  unlabeled');
  for (const r of rows) {
    const flag = r.overflow || r.unlabeled ? '  <-- check' : '';
    console.log(`${r.page.padEnd(22)} ${String(r.width).padStart(5)}  ${String(r.overflow).padStart(8)}  ${String(r.smallTargets).padStart(12)}  ${String(r.unlabeled).padStart(9)}${flag}`);
  }
  console.log('\nbrowser errors:', errors.length ? errors : 'none');
  console.log('layout problems:', problems.length ? problems : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
