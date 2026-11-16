/**
 * Repeat-run reliability of strict answering against the real knowledge base and model.
 *
 *   npx tsx tests/e2e/strict-stability.ts [repeats=3]
 *
 * A single run proves little here (retrieval, rewriting and scoring involve a language model), so every
 * question is asked several times. Supported questions must be answered from the indexed documents with
 * the expected content; unsupported ones must be refused with the fixed sentence EVERY time.
 * Pass criteria are strict for refusals (zero leakage) and ≥ 90% for supported answers.
 */
import 'dotenv/config';
import { generateAnswer } from '../../src/lib/rag/generate';
import { NO_ANSWER_TEXT } from '../../src/lib/rag/strict';
import { prisma } from '../../src/lib/db';

const REPEATS = Number(process.argv[2] ?? 3);

const SUPPORTED: [string, RegExp][] = [
  ['How do I actually get in touch with someone?', /\(916\)|916-|@/],
  ['What is the phone number for Golden Sierra Job Training Agency?', /746-7722|773-8540/],
  ["Where is the job center's street address?", /115 Ascot/],
  ['What are the office hours?', /8:00\s?am|8 am|Monday/i],
  ['Do I qualify for a training scholarship if I make $40,000 a year?', /low-income|English language/i],
  ['What is the exact dollar amount of the training scholarship?', /up to \$1,000/i],
  ['Who can get the Elevate Your Future scholarship?', /low-income|English language/i],
  ['What is Orbit?', /Zerodha|TradingView/i],
  ['What does the wage reimbursement program do for employers?', /wage|reimburs/i],
  ['Which counties does Golden Sierra serve?', /Placer[\s\S]*El Dorado|El Dorado[\s\S]*Placer/],
  ['Do I need an appointment to visit the job center?', /appointment/i],
  ['Do veterans get priority of service?', /priority/i],
  ['Which online learning platform is offered?', /Metrix/i],
  ['What is the fax number?', /771-2144|746-7733/],
  ['Tell me about the paid internship program', /internship/i],
  ['Who do you serve?', /Placer/i],
];
const UNSUPPORTED = [
  'What is the capital of France?', 'How do vaccines work?', 'Who won the 2022 World Cup?', 'Explain quantum entanglement.',
  'What is the weather going to be like tomorrow?', 'How much does a Tesla Model 3 cost?', 'What is the income limit for CalFresh?',
  'What is the minimum wage in Oregon?', "How do I renew my driver's license?", 'What is the best pizza in Sacramento?',
  'Can you recommend a good divorce lawyer?', 'What is Kubernetes?', 'How do I file my taxes?', 'Who is the president of Brazil?',
  'What is the square root of 144?', 'How do I reset my router?',
];

async function once(q: string) {
  const r = await generateAnswer({ message: q, history: [], profile: {} } as never);
  return { answer: r.answer, cites: r.payload.citations.length, reason: r.diagnostics?.noAnswerReason ?? null };
}

async function main() {
  let supportedOk = 0, supportedTotal = 0, leaks = 0, unsupportedTotal = 0;
  const problems: string[] = [];

  for (const [q, expect] of SUPPORTED) {
    const runs = await Promise.all(Array.from({ length: REPEATS }, () => once(q)));
    const ok = runs.filter((r) => r.answer !== NO_ANSWER_TEXT && r.cites > 0 && expect.test(r.answer)).length;
    supportedOk += ok; supportedTotal += runs.length;
    console.log(`${ok === runs.length ? 'ok  ' : ok === 0 ? 'FAIL' : 'flaky'}  ${ok}/${runs.length}  ${q}`);
    if (ok < runs.length) for (const r of runs.filter((r) => !(r.answer !== NO_ANSWER_TEXT && r.cites > 0 && expect.test(r.answer)))) problems.push(`${q} → [${r.reason}] ${r.answer.slice(0, 140).replace(/\n/g, ' ')}`);
  }
  for (const q of UNSUPPORTED) {
    const runs = await Promise.all(Array.from({ length: REPEATS }, () => once(q)));
    const bad = runs.filter((r) => r.answer !== NO_ANSWER_TEXT || r.cites > 0);
    leaks += bad.length; unsupportedTotal += runs.length;
    console.log(`${bad.length === 0 ? 'ok  ' : 'LEAK'}  ${runs.length - bad.length}/${runs.length} refused  ${q}`);
    for (const r of bad) problems.push(`LEAK ${q} → ${r.answer.slice(0, 200).replace(/\n/g, ' ')}`);
  }

  const rate = supportedOk / supportedTotal;
  console.log(`\nsupported answered correctly: ${supportedOk}/${supportedTotal} (${(rate * 100).toFixed(0)}%)`);
  console.log(`unsupported refused:          ${unsupportedTotal - leaks}/${unsupportedTotal}  (leaks: ${leaks})`);
  if (problems.length) console.log('\nDetails:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  const pass = leaks === 0 && rate >= 0.9;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  (criteria: zero leakage, ≥ 90% of supported answered correctly)`);
  process.exitCode = pass ? 0 : 1;
}
main().finally(() => prisma.$disconnect());
