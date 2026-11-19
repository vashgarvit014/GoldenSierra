/**
 * Conversation quality, both chat interfaces, real browser.
 *
 * Runs the same scripted conversations in the public chatbot (/, /api/session) and the admin
 * chat (/admin/chat, /api/chat), records every assistant turn exactly as the browser received
 * it, and scores it against the quality rules (length, one question, no repeats, perspective,
 * filler, quick replies, citations).
 *
 *   LABEL=before npx tsx tests/e2e/conversation-quality.ts
 *   ONLY=public|admin  SCENARIOS=1,2,3  HEADLESS=1
 *
 * The dev server should run with CHAT_RATE_LIMIT_PER_MIN raised: one pass sends ~100 turns.
 */
import { chromium, type Page, type Response } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const LABEL = process.env.LABEL ?? 'run';
const OUT = path.resolve('test-artifacts/conversation-quality');
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!';

type Mode = 'self' | 'helper';
type Step = string | { results: true };
type Scenario = { id: number; name: string; mode: Mode; steps: Step[] };

export const SCENARIOS: Scenario[] = [
  { id: 1, name: 'Unknown starting point (self)', mode: 'self', steps: ["I'm not sure where to start."] },
  { id: 2, name: 'Unknown starting point (helper)', mode: 'helper', steps: ["I'm not sure where to start."] },
  { id: 3, name: 'Job search', mode: 'self', steps: ['I need a job.', 'Placer County'] },
  { id: 4, name: 'Healthcare careers', mode: 'self', steps: ["I'd like to work in healthcare, maybe as a caregiver."] },
  { id: 5, name: 'Green-collar jobs', mode: 'self', steps: ["I'm interested in solar or other green energy jobs."] },
  { id: 6, name: 'White-collar jobs', mode: 'self', steps: ['I want an office job, something like an administrative assistant.'] },
  { id: 7, name: 'Education requirements', mode: 'self', steps: ['I want to become an accounting assistant.', 'I have a high school diploma.'] },
  { id: 8, name: 'Certification requirements', mode: 'self', steps: ['I want to work as an electrician.', "I don't have an electrician license."] },
  { id: 9, name: 'Previous experience', mode: 'self', steps: ['I worked 5 years in retail as a cashier. What can I do next?'] },
  { id: 10, name: 'Income urgency', mode: 'self', steps: ["I need money fast, I'm behind on rent."] },
  { id: 11, name: 'Location constraints', mode: 'self', steps: ["I live in Auburn and don't have a car. I'm looking for warehouse work."] },
  { id: 12, name: 'Helping someone', mode: 'helper', steps: ['My son is 19 and wants to start working.', 'He finished high school.'] },
  { id: 13, name: 'Looking for myself → final recommendations', mode: 'self', steps: ["I'm looking for a clerk job in Placer County.", 'I have a GED and 3 years of clerical experience.', { results: true }] },
  { id: 14, name: 'Correction', mode: 'self', steps: ["I'm in El Dorado County, looking for admin work.", 'Sorry, I meant Placer County, not El Dorado.'] },
  { id: 15, name: 'Follow-up question', mode: 'self', steps: ['What is the Elevate program?', 'Who can apply for it?'] },
  { id: 16, name: 'Early recommendations', mode: 'self', steps: ['I want caregiver work.', { results: true }] },
  { id: 17, name: 'Direct factual query', mode: 'self', steps: ['What services does Golden Sierra offer to employers?'] },
  { id: 18, name: 'Unsupported question', mode: 'self', steps: ['Can you help me file my taxes?'] },
  { id: 19, name: 'Missing qualifications', mode: 'self', steps: ['I want to be an electrician. I have 1 year of experience and no license.'] },
  { id: 20, name: 'Related-role matching', mode: 'helper', steps: ['She worked as a cashier for 4 years and wants an office job.'] },
  { id: 21, name: 'Full flow: greeting → background → requirements → jobs', mode: 'self', steps: ["Hi, I lost my job last month and I'm feeling really stressed.", 'I worked as a cashier for 3 years.', 'I finished high school.', "I'd like an office job, maybe a clerk.", { results: true }] },
  { id: 22, name: 'Full flow (helper): background → finance role → jobs from a crawled board', mode: 'helper', steps: ["I'm helping my daughter find work.", 'She worked as a bookkeeper for 6 years.', 'She has a college degree.', 'Something in finance, like a finance director.', { results: true }] },
  { id: 23, name: 'Crawled job board lookup', mode: 'self', steps: ['What jobs are posted on the El Dorado County Chamber job board?'] },
];

type Turn = { user: string; bot: string; quickReplies: string[]; citations: number; kind: string };
type Result = { ui: 'public' | 'admin'; scenario: number; name: string; mode: Mode; turns: Turn[]; issues: string[] };

const FILLER = [
  /^thanks for (letting me know|sharing)/i, /^great( question)?[,!.]/i, /^i understand\b/i, /^absolutely[,!.]/i, /^got it[,!.—-]/i, /^sure[,!.]/i,
  /\bI'll (look|search|focus|begin)\b/i, /\bnext,? i'll\b/i, /\bhappy to help\b/i, /\bfeel free to\b/i, /^it sounds like/i, /^i('ve| have) (noted|updated (her|his|their) profile)/i,
  /^(that'?s|it'?s) (a |so )?(solid|great|wonderful|meaningful|good|clear|strong|tough)\b/i, /completely normal/i, /quick check so i point you/i, /if you don'?t mind me asking/i, /\bI see you're asking\b/i,
];
/** Workforce/regional claims a clarifying turn cannot have a source for. */
const UNSOURCED = /\b(in[- ]demand|steady demand|high demand|momentum|widely available|tech-adjacent|corporate|industrial zones|around roseville|opens up most)\b/i;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const questions = (t: string) => t.split(/(?<=[?.!])\s+/).filter((s) => s.trim().endsWith('?'));
const norm = (q: string) => q.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/** Scores a conversation against the quality rules. Only clarification turns are length-checked. */
export function score(mode: Mode, turns: Turn[]): string[] {
  const issues: string[] = [];
  const asked = new Set<string>();
  const openers = new Set<string>();
  turns.forEach((t, i) => {
    const n = i + 1;
    const qs = questions(t.bot);
    const clarification = t.kind === 'question';
    if (clarification && words(t.bot) > 60) issues.push(`T${n} clarification is ${words(t.bot)} words`);
    if (/looking for work yourself, or hiring/i.test(t.bot)) issues.push(`T${n} asks "work or hiring?" after the mode was chosen`);
    if (clarification && UNSOURCED.test(t.bot)) issues.push(`T${n} unsourced workforce claim`);
    if (qs.length > 1) issues.push(`T${n} asks ${qs.length} questions`);
    for (const q of qs) {
      const k = norm(q);
      if (asked.has(k)) issues.push(`T${n} repeats a question: "${q}"`);
      asked.add(k);
    }
    for (const f of FILLER) if (f.test(t.bot)) issues.push(`T${n} filler: ${f.source}`);
    const opener = norm(t.bot).split(' ').slice(0, 4).join(' ');
    if (i > 0 && openers.has(opener)) issues.push(`T${n} repeats the opening "${opener}"`);
    openers.add(opener);
    if (mode === 'self' && /\b(they|their|the person you(?:'|’)re (?:helping|supporting))\b/i.test(qs.join(' '))) issues.push(`T${n} third person in self mode`);
    if (mode === 'helper' && /\b(do|have|did|are|were) you\b/i.test(qs.join(' '))) issues.push(`T${n} second person question in helper mode`);
    if (clarification && qs.length === 1 && (t.quickReplies.length < 2 || t.quickReplies.length > 4)) issues.push(`T${n} has ${t.quickReplies.length} quick replies`);
    if (/[ \t]{2,}|\.\.(?!\.)|\s[,.]|^\s|\n{3,}/.test(t.bot)) issues.push(`T${n} spacing/punctuation`);
  });
  return issues;
}

async function waitTurn(page: Page, ui: 'public' | 'admin', act: () => Promise<void>): Promise<Omit<Turn, 'user'>> {
  const urlPart = ui === 'public' ? '/api/session' : '/api/chat';
  const resP = page.waitForResponse((r: Response) => r.url().endsWith(urlPart) && r.request().method() === 'POST' && r.request().postData()?.includes('message') === true, { timeout: 150_000 });
  resP.catch(() => undefined);
  await act();
  const res = await resP;
  const body = await res.text();
  if (ui === 'public') {
    const d = JSON.parse(body) as { turn?: { message: string; quickReplies?: { label: string }[]; stage?: string; sources?: unknown[]; nextQuestion?: string | null } };
    const t = d.turn!;
    return { bot: t.message, quickReplies: (t.quickReplies ?? []).map((q) => q.label), citations: (t.sources ?? []).length, kind: t.stage === 'results' ? 'results' : t.nextQuestion ? 'question' : t.stage ?? 'answer' };
  }
  const done = body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.type === 'done') as { answer: string; payload: { flow?: { quickReplies?: { label: string }[]; stage?: string; question?: string | null }; citations?: unknown[] } };
  const f = done.payload.flow;
  return { bot: done.answer, quickReplies: (f?.quickReplies ?? []).map((q) => q.label), citations: (done.payload.citations ?? []).length, kind: f?.stage === 'SHOWING_RESULTS' || f?.stage === 'FOLLOW_UP' ? 'results' : f?.question ? 'question' : f?.stage ?? 'answer' };
}

async function runPublic(page: Page, s: Scenario): Promise<Turn[]> {
  await page.goto(BASE);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(BASE);
  await page.getByRole('button', { name: s.mode === 'self' ? /looking for myself/i : /helping someone/i }).first().click();
  await page.locator('#chat-input').waitFor();
  const turns: Turn[] = [];
  for (const step of s.steps) {
    if (typeof step === 'string') {
      turns.push({ user: step, ...(await waitTurn(page, 'public', async () => { await page.locator('#chat-input').fill(step); await page.locator('#chat-input').press('Enter'); })) });
    } else {
      const btn = page.getByRole('button', { name: /see recommendations|show me what fits|see (my )?results/i }).first();
      if ((await btn.count()) === 0) { turns.push({ user: '[results]', bot: '(no results control offered)', quickReplies: [], citations: 0, kind: 'none' }); continue; }
      turns.push({ user: '[results]', ...(await waitTurn(page, 'public', () => btn.click())) });
    }
    await page.waitForTimeout(400);
  }
  return turns;
}

async function runAdmin(page: Page, s: Scenario): Promise<Turn[]> {
  await page.goto(`${BASE}/admin/chat`);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}/admin/chat`);
  await page.getByTestId(s.mode === 'self' ? 'mode-self' : 'mode-helper').click();
  await page.getByTestId('opener').waitFor();
  const input = page.locator('#navInput');
  const turns: Turn[] = [];
  for (const step of s.steps) {
    if (typeof step === 'string') {
      turns.push({ user: step, ...(await waitTurn(page, 'admin', async () => { await input.fill(step); await input.press('Enter'); })) });
    } else {
      const btn = page.getByTestId('show-results');
      if ((await btn.count()) === 0) { turns.push({ user: '[results]', bot: '(no results control offered)', quickReplies: [], citations: 0, kind: 'none' }); continue; }
      turns.push({ user: '[results]', ...(await waitTurn(page, 'admin', () => btn.click())) });
    }
    await page.waitForTimeout(400);
  }
  return turns;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  if (process.env.RESCORE) {
    // Re-applies the current rules to a saved run, so before/after are judged identically.
    const saved = JSON.parse(readFileSync(process.env.RESCORE, 'utf8')) as Result[];
    for (const r of saved) r.issues = r.turns.length ? score(r.mode, r.turns) : r.issues;
    writeFileSync(process.env.RESCORE, JSON.stringify(saved, null, 2));
    for (const ui of ['public', 'admin'] as const) {
      const rs = saved.filter((r) => r.ui === ui);
      console.log(`${ui}: ${rs.reduce((n, r) => n + r.issues.length, 0)} issue(s) in ${rs.length} conversations; clean: ${rs.filter((r) => !r.issues.length).length}`);
    }
    return;
  }
  const only = process.env.ONLY;
  const pick = process.env.SCENARIOS?.split(',').map(Number);
  const list = SCENARIOS.filter((s) => !pick || pick.includes(s.id));
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await ctx.newPage();
  const results: Result[] = [];

  if (only !== 'admin') {
    for (const s of list) {
      try {
        const turns = await runPublic(page, s);
        results.push({ ui: 'public', scenario: s.id, name: s.name, mode: s.mode, turns, issues: score(s.mode, turns) });
      } catch (e) {
        results.push({ ui: 'public', scenario: s.id, name: s.name, mode: s.mode, turns: [], issues: [`ERROR ${(e as Error).message.split('\n')[0]}`] });
        await page.screenshot({ path: path.join(OUT, `${LABEL}-public-${s.id}-error.png`) });
      }
      console.log(`public #${s.id} ${results.at(-1)!.issues.length} issue(s)`);
    }
  }
  if (only !== 'public') {
    await page.goto(`${BASE}/admin/login`).catch(() => undefined);
    await page.goto(`${BASE}/admin/chat`);
    if (await page.locator('#email').count()) {
      await page.locator('#email').fill(EMAIL);
      await page.locator('#password').fill(PASSWORD);
      await page.locator('#password').press('Enter');
      await page.getByTestId('navigator').waitFor({ timeout: 30_000 });
    }
    for (const s of list) {
      try {
        const turns = await runAdmin(page, s);
        results.push({ ui: 'admin', scenario: s.id, name: s.name, mode: s.mode, turns, issues: score(s.mode, turns) });
      } catch (e) {
        results.push({ ui: 'admin', scenario: s.id, name: s.name, mode: s.mode, turns: [], issues: [`ERROR ${(e as Error).message.split('\n')[0]}`] });
        await page.screenshot({ path: path.join(OUT, `${LABEL}-admin-${s.id}-error.png`) });
      }
      console.log(`admin #${s.id} ${results.at(-1)!.issues.length} issue(s)`);
    }
  }
  await browser.close();
  const file = path.join(OUT, `${LABEL}${only ? `-${only}` : ''}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2));
  const total = results.reduce((n, r) => n + r.issues.length, 0);
  console.log(`\n${results.length} conversations, ${total} issue(s) → ${file}`);
})();
