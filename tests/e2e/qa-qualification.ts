/**
 * QA pass: qualification-aware job matching, driven entirely through the browser (/admin/chat).
 * For each scenario: the conversation is typed / clicked in Chrome; questions, the "What I know so far"
 * panel, the transcript and final cards are captured; every card is checked against PostgreSQL
 * (JobListing segment, Document, chunks) and Qdrant (points for the cited chunks); text citations are
 * checked against their chunks. Expectations are hand-labelled from the real listings' published text.
 * Read only (test chat sessions are deleted afterwards). Screenshots: test-artifacts/qa-qualification/.
 *
 *   PORT=3100 npm run dev   then   npx tsx tests/e2e/qa-qualification.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { prisma } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { getQdrant } from '../../src/lib/vector/qdrant';
import type { AssistantPayload, ChatTurn } from '../../src/types/chat';
import type { JobMatch } from '../../src/types/navigator';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const OUT = 'test-artifacts/qa-qualification';
fs.mkdirSync(OUT, { recursive: true });
const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');

type Step = { say?: string; quick?: RegExp; seeResults?: boolean };
type Expect = { label: string; ok: boolean; detail?: string };
type Scenario = {
  id: string; title: string; mode: 'self' | 'helper'; expected: string; steps: Step[];
  /** Hand-labelled expectations against the captured conversation. */
  assert: (c: Captured) => Expect[];
  /** Hand-labelled requirement outcomes: [listing title regex, requirement text regex, expected status]. */
  labels?: [RegExp, RegExp, 'met' | 'unmet' | 'unknown'][];
};
type Captured = { turns: ChatTurn[]; questions: string[]; questionIds: string[]; panel: string; final: AssistantPayload | undefined; jobs: JobMatch[]; groups: Record<string, string[]>; uiCards: string };

const jobsIn = (p?: AssistantPayload) => {
  const r = p?.navigator?.results;
  return r ? [...r.bestJobs, ...r.relatedJobs, ...(r.gapJobs ?? [])] : [];
};
const groupsOf = (p?: AssistantPayload) => {
  const r = p?.navigator?.results;
  return { best: r?.bestJobs.map((j) => j.title) ?? [], related: r?.relatedJobs.map((j) => j.title) ?? [], gaps: r?.gapJobs?.map((j) => j.title) ?? [] };
};
const job = (c: Captured, t: RegExp) => c.jobs.find((j) => t.test(j.title));
const req = (c: Captured, t: RegExp, r: RegExp) => job(c, t)?.requirements.find((x) => r.test(x.text));

const SCENARIOS: Scenario[] = [
  {
    id: '1', title: 'White-collar, education not mentioned', mode: 'self',
    expected: 'Asks a qualification question (education or experience) because shortlisted office listings publish requirements; no degree assumed for listings that do not require one.',
    steps: [{ say: "I'm looking for an office job in Roseville." }, { quick: /.*/ }, { seeResults: true }],
    assert: (c) => [
      { label: 'a qualification question was asked before results', ok: c.questionIds.some((q) => q.startsWith('qual:')), detail: c.questions.join(' || ') },
      { label: 'Legal Clerk (no degree requirement) is not marked as needing a degree', ok: !(job(c, /Legal Clerk/)?.requirements.some((r) => /degree/i.test(r.text)) ?? false) },
    ],
  },
  {
    id: '2', title: 'Healthcare, no certification', mode: 'self',
    expected: 'Mandatory certifications checked against the listing: the indexed caregiver listing provides its certificate after hire, so no certification is required or invented; it is not shown as unmet.',
    steps: [{ say: "I want a healthcare job near Auburn. I don't have any certifications." }, { seeResults: true }],
    assert: (c) => [
      { label: 'caregiver listing shown, with no mandatory certification', ok: !!job(c, /Caregiver/) && job(c, /Caregiver/)!.requirements.every((r) => !r.mandatory) },
      { label: 'no invented CNA/certification requirement in the message or cards', ok: !/\b(CNA|certification) (is )?required\b/i.test(JSON.stringify(c.final ?? {})) },
      { label: 'caregiver not in "needs a qualification first"', ok: !c.groups.gaps?.some((t) => /Caregiver/.test(t)) },
    ],
  },
  {
    id: '3', title: 'Green-collar, solar experience', mode: 'self',
    expected: 'Related roles (Electrician, Traffic/Lighting Technician) found via transferable experience; their experience requirements stay UNKNOWN (solar ≠ electrician years); shown as related, not best.',
    steps: [{ say: 'I have 4 years of experience installing solar panels and want a better job.' }, { seeResults: true }],
    labels: [[/^Electrician$/, /5 yrs full-time experience/, 'unknown']],
    assert: (c) => [
      { label: 'electrician or lighting technician found as a related role', ok: c.jobs.some((j) => j.kind === 'related' && /Electrician|Lighting/.test(j.title)) },
      { label: 'none of them presented as best match', ok: !c.groups.best?.some((t) => /Electrician|Lighting/.test(t)) },
    ],
  },
  {
    id: '4', title: 'Entry-level, no degree required', mode: 'self',
    expected: 'Legal Clerk publishes "12th grade" and "2 years clerical experience" — no degree. No degree question; experience asked instead.',
    steps: [{ say: 'I want an entry-level office clerk job. I have my high school diploma. I live in Auburn.' }, { quick: /2.4 years/ }, { seeResults: true }],
    labels: [[/Legal Clerk/, /12th grade/, 'met'], [/Legal Clerk/, /clerical experience/, 'met']],
    assert: (c) => [{ label: 'no degree question asked', ok: !c.questions.some((q) => /degree/i.test(q)), detail: c.questions.join(' || ') }],
  },
  {
    id: '5', title: 'Missing education is unknown, not failed', mode: 'self',
    expected: 'Accounting Assistant ("Relevant college degree, or equivalent…"): with education never stated, requirement UNKNOWN; card not in the gap group.',
    steps: [{ say: 'I want to work as an accounting assistant.' }, { seeResults: true }],
    labels: [[/Accounting Assistant/, /college degree/i, 'unknown']],
    assert: (c) => [{ label: 'Accounting Assistant not in the gap group', ok: !!job(c, /Accounting Assistant/) && !c.groups.gaps?.includes('Accounting Assistant') }],
  },
  {
    id: '6', title: 'Insufficient qualifications', mode: 'self',
    expected: 'Electrician (5 yrs or apprenticeship; Class C license) with 2 stated years and no license → both unmet; shown under "needs a qualification first", not as best.',
    steps: [{ say: "I worked as an electrician for 2 years and I don't have a driver's license." }, { seeResults: true }],
    labels: [[/^Electrician$/, /5 yrs full-time experience/, 'unmet'], [/^Electrician$/, /driver/, 'unmet']],
    assert: (c) => [
      { label: 'Electrician in the gap group', ok: c.groups.gaps?.includes('Electrician') ?? false, detail: JSON.stringify(c.groups) },
      { label: 'Electrician not presented as best/related match', ok: !c.groups.best?.includes('Electrician') && !c.groups.related?.includes('Electrician') },
    ],
  },
  {
    id: '7', title: 'Correction updates recommendations', mode: 'self',
    expected: 'No diploma → Legal Clerk "12th grade" unmet (gap). Corrected to GED + 3 years clerical → met; Clerk leaves the gap group.',
    steps: [{ say: "I want an office clerk job. I didn't finish high school." }, { seeResults: true }, { say: 'Actually I do have my GED now, and I have 3 years of clerical experience.' }],
    labels: [[/Legal Clerk/, /12th grade/, 'met'], [/Legal Clerk/, /clerical experience/, 'met']],
    assert: (c) => {
      const results = c.turns.filter((t) => t.payload?.navigator?.results);
      const first = results[0]?.payload, last = results.at(-1)?.payload;
      return [
        { label: 'before: Clerk in gap group with "12th grade" missing', ok: groupsOf(first).gaps.includes('Administrative Legal Clerk - Entry'), detail: JSON.stringify(groupsOf(first)) },
        { label: 'after: Clerk no longer in gap group (FOLLOW_UP)', ok: !groupsOf(last).gaps.includes('Administrative Legal Clerk - Entry') && last?.flow?.stage === 'FOLLOW_UP', detail: JSON.stringify(groupsOf(last)) },
      ];
    },
  },
  {
    id: '8', title: 'Early results before answering', mode: 'self',
    expected: 'See Results immediately → one optional targeted question with "Show results anyway"; results label uncertain matches (badge "not known yet" / "to confirm"), nothing marked unmet that was not stated.',
    steps: [{ say: 'I want to work in the trades.' }, { seeResults: true }, { quick: /Show results anyway/ }],
    assert: (c) => [
      { label: '"Show results anyway" offered', ok: c.turns.some((t) => t.payload?.flow?.quickReplies.some((q) => /Show results anyway/.test(q.label))) },
      { label: 'every card with unknown mandatory requirements is labelled as such in the UI', ok: c.jobs.filter((j) => j.qualification.unknown > 0).length === 0 || /not known yet|to confirm/i.test(c.uiCards), detail: c.uiCards.slice(0, 300) },
      { label: 'no requirement marked unmet without a stated fact', ok: c.jobs.every((j) => j.qualification.unmet === 0) },
    ],
  },
  {
    id: '9', title: 'Helper mode', mode: 'helper',
    expected: 'Third-person questions and context ("they"); panel shows "Helping someone else"; facts are about the person helped.',
    steps: [{ say: "I'm helping a 24-year-old who wants an office job. He has 1 year of clerical experience." }, { quick: /.*/ }, { seeResults: true }],
    assert: (c) => [
      { label: 'questions in third person', ok: c.questions.length > 0 && c.questions.every((q) => !/\b(do you|are you|have you|you have)\b/i.test(q)), detail: c.questions.join(' || ') },
      { label: 'panel shows "Helping someone else"', ok: /Helping someone else/.test(c.panel) },
    ],
  },
  {
    id: '10', title: 'Self-service mode', mode: 'self',
    expected: 'Second-person questions ("you").',
    steps: [{ say: 'I want to work as an administrative assistant in Placerville.' }, { quick: /.*/ }],
    assert: (c) => [{ label: 'questions in second person', ok: c.questions.length > 0 && c.questions.every((q) => /\byou(r)?\b/i.test(q) && !/\bthey\b/i.test(q)), detail: c.questions.join(' || ') }],
  },
];

/** Every card's fields and requirements are verbatim in its JobListing segment; chunks belong to its indexed document and exist in Qdrant. */
async function verifyCards(jobs: JobMatch[]): Promise<string[]> {
  const problems: string[] = [];
  for (const j of jobs) {
    const row = await prisma.jobListing.findUnique({ where: { id: j.id }, include: { document: true } });
    if (!row) { problems.push(`${j.title}: no JobListing row`); continue; }
    if (row.document.status !== 'INDEXED') problems.push(`${j.title}: document not indexed`);
    for (const [k, v] of Object.entries({ title: j.title, employer: j.employer, salary: j.salary, deadline: j.deadline })) if (v && !squash(row.segment).includes(squash(v))) problems.push(`${j.title}: ${k} not in listing`);
    if (j.listingStatus === 'closed') problems.push(`${j.title}: closed listing recommended`);
    for (const r of j.requirements) {
      if (!squash(row.segment).includes(squash(r.text))) problems.push(`${j.title}: requirement "${r.text}" not in listing`);
      const ch = await prisma.documentChunk.findMany({ where: { id: { in: r.source.chunkIds } } });
      if (!ch.length || ch.some((x) => x.documentId !== row.documentId)) problems.push(`${j.title}: requirement source chunks invalid`);
    }
    const ids = [...new Set([...j.source.chunkIds, ...j.requirements.flatMap((r) => r.source.chunkIds)])];
    const n = await getQdrant().count(env.QDRANT_COLLECTION, { exact: true, filter: { must: [{ key: 'chunkId', match: { any: ids } }] } });
    if (n.count !== ids.length) problems.push(`${j.title}: ${ids.length - n.count} cited chunk(s) missing from Qdrant`);
  }
  return problems;
}

async function verifyCitations(p?: AssistantPayload): Promise<string[]> {
  const problems: string[] = [];
  for (const c of p?.citations ?? []) {
    const rows = await prisma.documentChunk.findMany({ where: { id: { in: c.chunkIds ?? [] } }, include: { document: true } });
    if (!rows.length || rows.some((r) => r.document.status !== 'INDEXED' || r.document.url !== c.url)) problems.push(`citation [${c.id}] does not map to indexed chunks`);
  }
  return problems;
}

async function run(page: Page, s: Scenario) {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-testid=mode-${s.mode}]`).click();
  await page.locator('[data-testid=opener]').waitFor();
  const count = () => page.locator('[data-testid=assistant-message]').count();
  const wait = async (n: number) => {
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid=assistant-message]').length > k, n, { timeout: 180_000 });
    await page.waitForTimeout(500);
  };
  for (const step of s.steps) {
    const n = await count();
    if (step.say) {
      await page.locator('#navInput').fill(step.say);
      await page.locator('#navInput').press('Enter');
    } else if (step.seeResults) {
      if (await page.locator('[data-testid=show-results]').count()) await page.locator('[data-testid=show-results]').click();
      else { await page.locator('#navInput').fill('Show me the options you have so far'); await page.locator('#navInput').press('Enter'); }
    } else if (step.quick) {
      const q = page.locator('[data-testid=quick-reply]').filter({ hasText: step.quick });
      if (!(await q.count())) continue;
      await q.first().click();
    }
    await wait(n);
    // An optional pre-results question after "See Results" is answered with "Show results anyway"
    // unless the scenario itself clicks it.
    if (step.seeResults && s.id !== '8') {
      const anyway = page.locator('[data-testid=quick-reply]').filter({ hasText: /Show results anyway/ });
      if (await anyway.count()) { const m = await count(); await anyway.click(); await wait(m); }
    }
  }
  const stored = await page.evaluate(() => sessionStorage.getItem('gs_navigator_session'));
  const sess = JSON.parse(stored!) as { id: string; token: string };
  const data = (await (await page.request.get(`${BASE}/api/chat/session/${sess.id}?token=${encodeURIComponent(sess.token)}`)).json()) as { messages: ChatTurn[] };
  const turns = data.messages;
  const assistant = turns.filter((t) => t.role === 'assistant');
  const final = [...assistant].reverse().find((t) => t.payload?.navigator?.results)?.payload;
  const questions = assistant.map((t) => t.payload?.flow?.question).filter(Boolean) as string[];
  const fs0 = await prisma.chatSession.findUnique({ where: { id: sess.id }, select: { profile: true } });
  const questionIds = ((fs0?.profile as { flow?: { askedQuestions?: string[] } })?.flow?.askedQuestions) ?? [];
  const panel = await page.locator('[data-testid=known-facts]').innerText();
  const uiCards = (await page.locator('[data-testid=results]').count()) ? await page.locator('[data-testid=results]').last().innerText() : '';
  await page.screenshot({ path: `${OUT}/${s.id}-final.png`, fullPage: false });
  return { sessionId: sess.id, captured: { turns, questions, questionIds, panel, final, jobs: jobsIn(final), groups: groupsOf(final), uiCards } as Captured };
}

(async () => {
  const report: Record<string, unknown>[] = [];
  const sessionIds: string[] = [];
  let labelled = 0, labelledRight = 0;
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
  if (await page.locator('#email').count()) {
    await page.locator('#email').fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@goldensierra.test');
    await page.locator('#password').fill(process.env.E2E_ADMIN_PASSWORD ?? 'TestPassword123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.sidebar').waitFor({ timeout: 25_000 });
    await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle' });
  }
  for (const s of SCENARIOS) {
    let entry: Record<string, unknown>;
    try {
      const { sessionId, captured: c } = await run(page, s);
      sessionIds.push(sessionId);
      const checks = s.assert(c);
      for (const [t, r, want] of s.labels ?? []) {
        labelled++;
        const got = req(c, t, r)?.status ?? 'missing';
        if (got === want) labelledRight++;
        checks.push({ label: `requirement ${r} on ${t} is ${want}`, ok: got === want, detail: `got ${got}` });
      }
      const cardProblems = await verifyCards(c.jobs);
      const citeProblems = await verifyCitations(c.final);
      const repeated = c.questionIds.filter((q, i) => c.questionIds.indexOf(q) !== i);
      const eligibilityClaims = c.turns.filter((t) => t.role === 'assistant' && /\b(is|are) eligible\b|\bqualif(y|ies) for (the|this) job\b|\bwill be hired\b|\bcurrently open\b/i.test(t.content));
      checks.push({ label: 'cards verified against PostgreSQL + Qdrant', ok: cardProblems.length === 0, detail: cardProblems.join('; ') });
      checks.push({ label: 'citations map to indexed chunks', ok: citeProblems.length === 0, detail: citeProblems.join('; ') });
      checks.push({ label: 'no question asked twice', ok: repeated.length === 0, detail: repeated.join(',') });
      checks.push({ label: 'no eligibility / "currently open" claims', ok: eligibilityClaims.length === 0, detail: eligibilityClaims.map((t) => t.content.slice(0, 120)).join(' | ') });
      checks.push({ label: 'final results reached with "What I know so far" populated', ok: (s.id === '10' || !!c.final) && c.panel.split('\n').length > 2, detail: c.panel });
      const pass = checks.every((x) => x.ok);
      if (!pass) await page.screenshot({ path: `${OUT}/${s.id}-FAIL.png`, fullPage: true });
      entry = {
        scenario: `${s.id}. ${s.title}`, mode: s.mode, expected: s.expected, pass,
        questionsAsked: c.questions, questionIds: c.questionIds,
        panel: c.panel.replace(/\n+/g, ' | '),
        groups: c.groups,
        cards: c.jobs.map((j) => ({ title: j.title, kind: j.kind, fit: j.qualification.fit, requirements: j.requirements.map((r) => `${r.mandatory ? 'REQ' : 'pref'} ${r.status}: ${r.text}`) })),
        citations: c.final?.citations.map((x) => x.url) ?? [],
        transcript: c.turns.map((t) => `${t.role === 'user' ? 'U' : 'A'}: ${t.content.replace(/\s+/g, ' ').slice(0, 400)}`),
        checks,
      };
    } catch (err) {
      await page.screenshot({ path: `${OUT}/${s.id}-FAIL.png`, fullPage: true }).catch(() => undefined);
      entry = { scenario: `${s.id}. ${s.title}`, pass: false, error: err instanceof Error ? err.message : String(err) };
    }
    report.push(entry);
    console.log(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.scenario}`);
    for (const c of (entry.checks as Expect[] | undefined) ?? []) if (!c.ok) console.log(`      ✕ ${c.label} → ${(c.detail ?? '').slice(0, 300)}`);
    if (entry.error) console.log(`      ✕ ${entry.error}`);
  }
  await browser.close();
  await prisma.chatSession.deleteMany({ where: { id: { in: sessionIds } } });
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ labelled, labelledRight, report }, null, 2));
  console.log(`\nhand-labelled requirement outcomes: ${labelledRight}/${labelled}`);
  console.log(`${report.filter((r) => r.pass).length}/${report.length} scenarios passed`);
  await prisma.$disconnect();
})();
