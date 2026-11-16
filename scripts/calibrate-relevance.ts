/**
 * Calibrates the strict-RAG relevance gate against the real indexed knowledge base.
 *
 *   npx tsx scripts/calibrate-relevance.ts [--json]
 *
 * Deterministic: embedding + Qdrant + PostgreSQL only, no LLM. For each labelled query it reports
 *  - answerable queries: whether a chunk that really contains the answer survives the gate (recall)
 *  - unanswerable queries: whether anything survives the gate and the knowledge-base term profile (leak)
 * under the previous rule (all terms, literal) and the current rule (topical terms, concept-aware),
 * then sweeps the semantic thresholds so they are chosen from data, not guessed.
 */
import 'dotenv/config';
import { retrieve } from '../src/lib/rag/retrieve';
import { ruleBasedAnalysis } from '../src/lib/rag/understand';
import {
  contentTerms, lexicalCoverage, namedUnknowns, outsideKnowledgeBase, profileTerms, relevanceGate, stemSet, THRESHOLDS, validateChunks,
} from '../src/lib/rag/strict';
import type { RetrievedSource } from '../src/types/chat';
import { prisma } from '../src/lib/db';

type Positive = { q: string; answer: RegExp; url?: RegExp };
const POSITIVE: Positive[] = [
  { q: 'How do I actually get in touch with someone?', answer: /746-7722/ },
  { q: 'What is the phone number for the job center?', answer: /746-7722/ },
  { q: 'What is the phone number for Golden Sierra Job Training Agency?', answer: /746-7722/ },
  { q: 'Where is the America’s Job Center located?', answer: /115 Ascot/ },
  { q: 'What are the office hours?', answer: /8:00am – 4:30pm/ },
  { q: 'Do I qualify for a training scholarship if I make $40,000 a year?', answer: /To find out if you qualify/ },
  { q: 'What is the exact dollar amount of the training scholarship?', answer: /up to \$1,000/ },
  { q: 'Who can get the Elevate Your Future scholarship?', answer: /English language learners or low-income/ },
  { q: 'What is Orbit?', answer: /./, url: /orbit\.dotstark\.tech/ },
  { q: 'What does the wage reimbursement program do for employers?', answer: /wage reimbursement/i },
  { q: 'Which counties does Golden Sierra serve?', answer: /Placer, El Dorado, and Alpine/ },
  { q: 'Do I need an appointment to visit the job center?', answer: /No appointment is necessary/ },
  { q: 'Do veterans get priority of service?', answer: /veterans and eligible spouses receive priority/ },
  { q: 'Is there a way to send you a message?', answer: /send us a message/ },
  { q: 'Which online learning platform is offered?', answer: /Metrix Learning/ },
  { q: 'Is there a free computer class?', answer: /Computer Basics Boot Camp/ },
  { q: 'What is the fax number?', answer: /771-2144|746-7733/ },
  { q: 'Tell me about the paid internship program', answer: /paid internship/i },
  { q: 'How can I find job openings?', answer: /handpicked, local openings/ },
  { q: 'Where is the administrative office?', answer: /Administrative Office/ },
  { q: 'Who do you serve?', answer: /Placer, El Dorado, and Alpine/ },
];
const NEGATIVE: string[] = [
  'What is the capital of France?',
  'How do vaccines work?',
  'Who won the 2022 World Cup?',
  'Explain quantum entanglement.',
  'How does photosynthesis work?',
  'What is the weather going to be like tomorrow?',
  'How much does a Tesla Model 3 cost?',
  'What is the income limit for CalFresh?',
  'What is the minimum wage in Oregon?',
  'How do I renew my driver’s license?',
  'What is the best pizza in Sacramento?',
  'Can you recommend a good divorce lawyer?',
  'What is Kubernetes?',
  'How do I file my taxes?',
  'What is the CEO’s salary at Google?',
  'Who is the president of Brazil?',
  'What is the square root of 144?',
  'How do I reset my router?',
];

const literalSet = (text: string) => new Set([...stemSet(text)].filter((k) => !k.startsWith('@')));
const hayOf = (s: RetrievedSource) => `${s.title} ${s.headingPath ?? ''} ${s.snippet}`;

type Verdict = { pass: boolean; cov: number };
function gate(rule: 'old' | 'new', terms: ReturnType<typeof contentTerms>, profile: Awaited<ReturnType<typeof profileTerms>>, s: RetrievedSource, t = THRESHOLDS): Verdict {
  if (rule === 'new') {
    const g = relevanceGate(terms, [s], profile);
    return { pass: g.relevant.length > 0, cov: g.coverage.get(s.chunkId) ?? 0 };
  }
  const cov = lexicalCoverage(terms, literalSet(hayOf(s)));
  const sim = s.similarity ?? 0;
  const pass = cov >= t.minLexicalCoverage || (sim >= t.semanticOverride && cov >= t.semanticMinCoverage) || sim >= t.semanticAlone;
  return { pass, cov };
}

async function evidence(q: string) {
  const analysis = ruleBasedAnalysis(q, []);
  const generic = analysis.intent === 'off_topic' || analysis.intent === 'general_info';
  const query = analysis.rewrittenQuery || q;
  const terms = contentTerms(query);
  const r = await retrieve({ ...analysis, intent: generic ? 'off_topic' : analysis.intent, keywords: terms.map((t) => t.raw) }, {}, { expand: !generic });
  const { valid } = await validateChunks(r.sources);
  const profile = await profileTerms(terms);
  return { analysis, terms, valid, profile };
}

async function main() {
  const rows: Record<string, unknown>[] = [];
  const posData: { q: string; hits: { sim: number; old: Verdict; neu: Verdict }[] }[] = [];
  const negData: { q: string; survivors: { sim: number; old: boolean; neu: boolean }[]; outside: boolean }[] = [];

  for (const p of POSITIVE) {
    const { terms, valid, profile } = await evidence(p.q);
    const matching = valid.filter((s) => (p.url ? p.url.test(s.url ?? '') : true) && p.answer.test(s.snippet));
    const hits = matching.map((s) => ({ sim: s.similarity ?? 0, old: gate('old', terms, profile, s), neu: gate('new', terms, profile, s) }));
    posData.push({ q: p.q, hits });
    const best = (k: 'old' | 'neu') => hits.some((h) => h[k].pass);
    rows.push({
      kind: 'answerable', q: p.q.slice(0, 58), retrieved: matching.length > 0, maxSim: Math.max(0, ...hits.map((h) => h.sim)).toFixed(2),
      old: best('old') ? 'pass' : 'MISS', new: best('neu') ? 'pass' : 'MISS',
    });
  }
  for (const q of NEGATIVE) {
    const { terms, valid, profile } = await evidence(q);
    const outside = outsideKnowledgeBase(profile, namedUnknowns(q, profile.unknown));
    const survivors = valid.map((s) => ({ sim: s.similarity ?? 0, old: gate('old', terms, profile, s).pass, neu: gate('new', terms, profile, s).pass }));
    negData.push({ q, survivors, outside });
    rows.push({
      kind: 'unanswerable', q: q.slice(0, 58), unknownTerms: profile.unknown.join(',') || '-',
      old: outside ? 'refused(profile)' : survivors.some((x) => x.old) ? `LEAK x${survivors.filter((x) => x.old).length}` : 'refused',
      new: outside ? 'refused(profile)' : survivors.some((x) => x.neu) ? `LEAK x${survivors.filter((x) => x.neu).length}` : 'refused',
    });
  }

  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);

  const recall = (k: 'old' | 'neu') => posData.filter((d) => d.hits.some((h) => h[k].pass)).length;
  const retrieved = posData.filter((d) => d.hits.length > 0).length;
  const leak = (k: 'old' | 'neu') => negData.filter((d) => !d.outside && d.survivors.some((x) => x[k])).length;
  console.log(`\nanswerable: ${posData.length}  answer chunk retrieved: ${retrieved}`);
  console.log(`  gate recall   old ${recall('old')}/${posData.length}   new ${recall('neu')}/${posData.length}`);
  console.log(`unanswerable: ${negData.length}  reaching the model (gate+profile)   old ${leak('old')}   new ${leak('neu')}   (the LLM veto and claim verifier still apply after this)`);

  // Threshold sweep for the new rule: maximise recall with zero additional leakage.
  console.log('\nsweep (new rule): semanticOverride / semanticAlone -> recall, leaks');
  const profiles = new Map<string, Awaited<ReturnType<typeof evidence>>>();
  for (const p of POSITIVE) profiles.set(p.q, await evidence(p.q));
  for (const q of NEGATIVE) profiles.set(q, await evidence(q));
  for (const ov of [0.56, 0.58, 0.6, 0.62, 0.64]) {
    for (const alone of [0.66, 0.7, 0.74]) {
      const t = { ...THRESHOLDS, semanticOverride: ov, semanticAlone: alone } as typeof THRESHOLDS;
      let rec = 0, lk = 0;
      for (const p of POSITIVE) {
        const e = profiles.get(p.q)!;
        const m = e.valid.filter((s) => (p.url ? p.url.test(s.url ?? '') : true) && p.answer.test(s.snippet));
        if (m.some((s) => gate('new', e.terms, e.profile, s, t).pass)) rec++;
      }
      for (const q of NEGATIVE) {
        const e = profiles.get(q)!;
        if (!outsideKnowledgeBase(e.profile, namedUnknowns(q, e.profile.unknown)) && e.valid.some((s) => gate('new', e.terms, e.profile, s, t).pass)) lk++;
      }
      console.log(`  override ${ov.toFixed(2)}  alone ${alone.toFixed(2)}  recall ${rec}/${POSITIVE.length}  leaks ${lk}/${NEGATIVE.length}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
