import { prisma } from '../db';
import { generateAnswer } from '../rag/generate';
import type { ChatTurn, UserProfile } from '@/types/chat';
import { ruleBasedAnalysis } from '../rag/understand';

/**
 * Reference-based evaluation.
 *
 * Measures the behaviours the brief calls for — correct intent, relevant
 * services, real citations, no fabricated claims, consolidation rather than
 * chunk-dumping — against stored EvalCase rows.
 *
 * On the acceptance criteria: there are none hard-coded here, deliberately.
 * The brief asks for "realistic acceptance criteria after establishing a test
 * baseline", and a threshold invented before the first run would be a guess
 * dressed as a standard. Run the suite, read the baseline it prints, then set
 * thresholds in CI from numbers you have actually observed.
 */

export type DimensionScores = {
  /** Did query understanding identify the right intent? */
  intent: number;
  /** Fraction of expected programs that were recommended. */
  programRecall: number;
  /** Fraction of expected source URLs that were cited. */
  sourceAccuracy: number;
  /** Did it cite anything at all, and did retrieval find evidence? */
  grounded: number;
  /** 1 when no forbidden phrase appeared. */
  noForbiddenClaims: number;
  /** 1 when the grounding checker found no unsupported claim. */
  noUnsupportedClaims: number;
  /** Did it end with an actionable next step? */
  actionable: number;
  /** Did it stay within the target length? */
  concise: number;
  /** Did it avoid pasting a retrieved passage verbatim? */
  synthesized: number;
};

export type CaseResult = {
  caseId: string;
  name: string;
  question: string;
  answer: string;
  intent: string;
  expectedIntent: string | null;
  programsFound: string[];
  sourcesFound: string[];
  scores: DimensionScores;
  overall: number;
  passed: boolean;
  failures: string[];
  latencyMs: number;
};

const WEIGHTS: Record<keyof DimensionScores, number> = {
  intent: 1,
  programRecall: 1.5,
  sourceAccuracy: 1.5,
  grounded: 1.5,
  // Fabrication is the failure that actually harms someone, so it dominates.
  noForbiddenClaims: 3,
  noUnsupportedClaims: 3,
  actionable: 1,
  concise: 0.5,
  synthesized: 1,
};

/** A case passes only if it never fabricates, whatever else it scores. */
const MUST_PASS: (keyof DimensionScores)[] = ['noForbiddenClaims', 'noUnsupportedClaims'];

export async function runCase(evalCase: {
  id: string;
  name: string;
  question: string;
  history: unknown;
  expectedIntent: string | null;
  expectedPrograms: string[];
  expectedSources: string[];
  forbiddenPhrases: string[];
}): Promise<CaseResult> {
  const started = Date.now();

  const rawHistory = Array.isArray(evalCase.history)
    ? (evalCase.history as { role: string; content: string }[])
    : [];
  const history: ChatTurn[] = rawHistory.map((turn, i) => ({
    id: `eval-${i}`,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.content,
    createdAt: new Date().toISOString(),
  }));

  // Carry forward any profile the earlier turns established, exactly as a
  // real session would — otherwise follow-up cases test nothing.
  let profile: UserProfile = {};
  for (const turn of rawHistory) {
    if (turn.role !== 'user') continue;
    profile = { ...profile, ...ruleBasedAnalysis(turn.content, []).profileUpdates };
  }

  const result = await generateAnswer({ message: evalCase.question, history, profile });

  const answer = result.answer;
  const lower = answer.toLowerCase();
  const failures: string[] = [];

  // ── Intent ──
  const intentScore = !evalCase.expectedIntent
    ? 1
    : result.analysis.intent === evalCase.expectedIntent
      ? 1
      : 0;
  if (intentScore === 0) {
    failures.push(`intent: expected ${evalCase.expectedIntent}, got ${result.analysis.intent}`);
  }

  // ── Programs ──
  const programsFound = result.payload.recommendations
    .map((r) => r.slug)
    .filter((s): s is string => Boolean(s));
  const expectedPrograms = evalCase.expectedPrograms;
  const matchedPrograms = expectedPrograms.filter(
    (slug) => programsFound.includes(slug) || lower.includes(slug.replace(/-/g, ' ')),
  );
  const programRecall = expectedPrograms.length === 0 ? 1 : matchedPrograms.length / expectedPrograms.length;
  if (programRecall < 1 && expectedPrograms.length > 0) {
    failures.push(
      `programs: missing ${expectedPrograms.filter((s) => !matchedPrograms.includes(s)).join(', ')}`,
    );
  }

  // ── Sources ──
  const sourcesFound = result.payload.citations.map((c) => c.url ?? c.title);
  const matchedSources = evalCase.expectedSources.filter((expected) =>
    sourcesFound.some((found) => found.toLowerCase().includes(expected.toLowerCase())),
  );
  const sourceAccuracy =
    evalCase.expectedSources.length === 0 ? 1 : matchedSources.length / evalCase.expectedSources.length;
  if (sourceAccuracy < 1 && evalCase.expectedSources.length > 0) {
    failures.push('sources: expected citations were not present');
  }

  // ── Grounding ──
  const expectsEvidence = evalCase.expectedSources.length > 0;
  const grounded = expectsEvidence ? (result.payload.grounded ? 1 : 0) : 1;
  if (grounded === 0) failures.push('grounding: answer was not backed by retrieved sources');

  // ── Fabrication guards ──
  const hitPhrases = evalCase.forbiddenPhrases.filter((phrase) =>
    lower.includes(phrase.toLowerCase()),
  );
  const noForbiddenClaims = hitPhrases.length === 0 ? 1 : 0;
  if (hitPhrases.length) failures.push(`forbidden phrase present: ${hitPhrases.join(', ')}`);

  const noUnsupportedClaims = result.grounding.unsupportedClaims.length === 0 ? 1 : 0;
  if (noUnsupportedClaims === 0) {
    failures.push(`unsupported claims: ${result.grounding.unsupportedClaims.join(', ')}`);
  }

  // ── Actionability ──
  // Not applicable to an off-topic redirect: there is no workforce next step
  // to offer, and padding one in would make the answer worse.
  const expectsAction = result.analysis.intent !== 'off_topic';
  const actionable = !expectsAction
    ? 1
    : /\b(call|contact|visit|submit|browse|check|register|apply|reach|speak|start)\b/i.test(answer)
      ? 1
      : 0;
  if (actionable === 0) failures.push('no actionable next step');

  // ── Length ──
  const words = answer.split(/\s+/).filter(Boolean).length;
  const concise = words <= 330 ? 1 : words <= 450 ? 0.5 : 0;
  if (concise < 1) failures.push(`length: ${words} words`);

  // ── Synthesis ──
  // A long verbatim run from a retrieved passage means it pasted rather than
  // consolidated, which is the specific failure the brief warns against.
  const synthesized = result.payload.sources.some((source) =>
    longestSharedRun(answer, source.snippet) > 180,
  )
    ? 0
    : 1;
  if (synthesized === 0) failures.push('answer copied a retrieved passage verbatim');

  const scores: DimensionScores = {
    intent: intentScore,
    programRecall,
    sourceAccuracy,
    grounded,
    noForbiddenClaims,
    noUnsupportedClaims,
    actionable,
    concise,
    synthesized,
  };

  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const overall =
    (Object.entries(scores) as [keyof DimensionScores, number][]).reduce(
      (sum, [key, value]) => sum + value * WEIGHTS[key],
      0,
    ) / totalWeight;

  const passed = MUST_PASS.every((key) => scores[key] === 1) && overall >= 0.7;

  return {
    caseId: evalCase.id,
    name: evalCase.name,
    question: evalCase.question,
    answer,
    intent: result.analysis.intent,
    expectedIntent: evalCase.expectedIntent,
    programsFound,
    sourcesFound,
    scores,
    overall,
    passed,
    failures,
    latencyMs: Date.now() - started,
  };
}

/** Longest common substring length — detects verbatim copying. */
function longestSharedRun(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, ' ');
  const y = b.toLowerCase().replace(/\s+/g, ' ');
  if (!x || !y) return 0;

  // Rolling window rather than full DP: we only need to know whether any run
  // exceeds the threshold, and the full table would be ~1MB per comparison.
  let best = 0;
  let previous = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const current = new Uint16Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}

export type SuiteResult = {
  results: CaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    averageOverall: number;
    averageLatencyMs: number;
    dimensionAverages: DimensionScores;
  };
};

export async function runSuite(options: { persist?: boolean } = {}): Promise<SuiteResult> {
  const cases = await prisma.evalCase.findMany({ orderBy: { createdAt: 'asc' } });
  if (cases.length === 0) {
    throw new Error('No evaluation cases found. Run `npm run db:seed` first.');
  }

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    // Sequential on purpose: parallel runs distort the latency measurement
    // and can trip provider rate limits mid-suite.
    results.push(await runCase(evalCase));
  }

  if (options.persist) {
    for (const result of results) {
      await prisma.evalRun.create({
        data: {
          caseId: result.caseId,
          answer: result.answer,
          intent: result.intent,
          programsFound: result.programsFound,
          sourcesFound: result.sourcesFound,
          scores: result.scores as never,
          passed: result.passed,
          latencyMs: result.latencyMs,
        },
      });
    }
  }

  const keys = Object.keys(WEIGHTS) as (keyof DimensionScores)[];
  const dimensionAverages = Object.fromEntries(
    keys.map((key) => [key, mean(results.map((r) => r.scores[key]))]),
  ) as DimensionScores;

  const passed = results.filter((r) => r.passed).length;

  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 0,
      averageOverall: mean(results.map((r) => r.overall)),
      averageLatencyMs: Math.round(mean(results.map((r) => r.latencyMs))),
      dimensionAverages,
    },
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
