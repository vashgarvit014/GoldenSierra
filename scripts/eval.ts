/**
 * Runs the reference evaluation suite and prints a baseline report.
 *
 *   npm run eval              # run and print
 *   npm run eval -- --save    # also record each run in the database
 *   npm run eval -- --json    # machine-readable output for CI
 *
 * Requires a configured LLM and an indexed knowledge base.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { runSuite, type DimensionScores } from '../src/lib/eval/runner';
import { hasLlm } from '../src/lib/env';
import { auditIndex } from '../src/lib/ingest/pipeline';

const flag = (name: string) => process.argv.includes(`--${name}`);

const DIMENSION_LABELS: Record<keyof DimensionScores, string> = {
  intent: 'Intent identification',
  programRecall: 'Recommendation relevance',
  sourceAccuracy: 'Source accuracy',
  grounded: 'Grounded in sources',
  noForbiddenClaims: 'No forbidden claims',
  noUnsupportedClaims: 'No unsupported claims',
  actionable: 'Actionable next steps',
  concise: 'Response length',
  synthesized: 'Consolidated (not pasted)',
};

async function main() {
  if (!hasLlm()) {
    console.error(
      'LLM_API_KEY is not set. The evaluation suite measures generated answers and cannot run without a model.',
    );
    process.exit(1);
  }

  const index = await auditIndex();
  if (index.indexedDocuments === 0) {
    console.error('No documents are indexed. Run `npm run ingest` before evaluating.');
    process.exit(1);
  }

  console.log(`Evaluating against ${index.indexedDocuments} indexed documents…\n`);

  const { results, summary } = await runSuite({ persist: flag('save') });

  if (flag('json')) {
    console.log(JSON.stringify({ summary, results }, null, 2));
    return;
  }

  for (const result of results) {
    const mark = result.passed ? '✓' : '✗';
    console.log(`${mark} ${result.name}`);
    console.log(`    score ${(result.overall * 100).toFixed(0)}%  ·  ${result.latencyMs}ms`);
    if (result.failures.length) {
      for (const failure of result.failures) console.log(`    – ${failure}`);
    }
    console.log('');
  }

  console.log('── Baseline ──────────────────────────────────────');
  console.log(`  Cases           : ${summary.total}`);
  console.log(`  Passed          : ${summary.passed} (${(summary.passRate * 100).toFixed(0)}%)`);
  console.log(`  Average score   : ${(summary.averageOverall * 100).toFixed(0)}%`);
  console.log(`  Average latency : ${summary.averageLatencyMs}ms`);
  console.log('\n  By dimension:');
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const value = summary.dimensionAverages[key as keyof DimensionScores];
    const bar = '█'.repeat(Math.round(value * 20)).padEnd(20, '·');
    console.log(`    ${label.padEnd(28)} ${bar} ${(value * 100).toFixed(0)}%`);
  }

  console.log(
    '\nThese numbers are a baseline, not a target. Set CI thresholds from observed\n' +
      'values, and add the project owner\'s real reference transcripts as EvalCase\n' +
      'rows before treating any score as a measure of parity with the reference tool.',
  );

  // Fabrication failures should break a pipeline; a low score alone should not.
  const fabricated = results.filter(
    (r) => r.scores.noForbiddenClaims === 0 || r.scores.noUnsupportedClaims === 0,
  );
  if (fabricated.length) {
    console.error(`\n${fabricated.length} case(s) produced unsupported claims.`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('\nEvaluation failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
