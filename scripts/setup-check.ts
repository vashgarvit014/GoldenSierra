/**
 * Pre-flight check. Verifies every dependency the app needs before you try to
 * use it, and says exactly what to do about anything that is missing.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { env, hasLlm, hasEmbeddings, hasRedis } from '../src/lib/env';
import { collectionStats, qdrantHealthy } from '../src/lib/vector/qdrant';
import { auditIndex } from '../src/lib/ingest/pipeline';

type Check = { name: string; ok: boolean; detail: string; fix?: string };

async function main() {
  const checks: Check[] = [];

  // ── Postgres ──
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [documents, programs, sources] = await Promise.all([
      prisma.document.count(),
      prisma.program.count(),
      prisma.knowledgeSource.count(),
    ]);
    checks.push({
      name: 'PostgreSQL',
      ok: true,
      detail: `connected · ${documents} documents, ${programs} programs, ${sources} sources`,
      fix: programs === 0 ? 'Run: npm run db:seed' : undefined,
    });
  } catch (err) {
    checks.push({
      name: 'PostgreSQL',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Run: docker compose up -d postgres && npm run db:migrate',
    });
  }

  // ── Qdrant ──
  if (await qdrantHealthy()) {
    const stats = await collectionStats();
    checks.push({
      name: 'Qdrant',
      ok: true,
      detail: stats.exists
        ? `collection "${env.QDRANT_COLLECTION}" · ${stats.vectorCount} vectors · ${stats.dimensions}d`
        : `reachable, but collection "${env.QDRANT_COLLECTION}" does not exist`,
      fix: stats.exists ? undefined : 'Run: npm run vector:init',
    });
  } else {
    checks.push({
      name: 'Qdrant',
      ok: false,
      detail: `cannot reach ${env.QDRANT_URL}`,
      fix: 'Run: docker compose up -d qdrant',
    });
  }

  // ── Models ──
  checks.push({
    name: 'Language model',
    ok: hasLlm(),
    detail: hasLlm() ? `${env.LLM_MODEL} via ${env.LLM_BASE_URL}` : 'LLM_API_KEY is not set',
    fix: hasLlm() ? undefined : 'Set LLM_API_KEY in .env — the chatbot cannot answer without it.',
  });

  checks.push({
    name: 'Embedding model',
    ok: hasEmbeddings(),
    detail: hasEmbeddings()
      ? `${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS}d)`
      : 'EMBEDDING_API_KEY is not set',
    fix: hasEmbeddings() ? undefined : 'Set EMBEDDING_API_KEY in .env — indexing cannot run without it.',
  });

  // ── Optional ──
  checks.push({
    name: 'Job queue',
    ok: true,
    detail: hasRedis() ? 'Redis configured (BullMQ)' : 'in-process (no Redis configured)',
    fix: hasRedis() ? 'Start the worker: npm run ingest:worker' : undefined,
  });

  checks.push({
    name: 'Auth secret',
    ok: Boolean(env.AUTH_SECRET && env.AUTH_SECRET.length >= 32),
    detail: env.AUTH_SECRET ? 'set' : 'missing or too short',
    fix: env.AUTH_SECRET && env.AUTH_SECRET.length >= 32
      ? undefined
      : 'Generate one: openssl rand -base64 48',
  });

  // ── Index consistency ──
  try {
    const index = await auditIndex();
    checks.push({
      name: 'Index consistency',
      ok: index.missingVectors === 0,
      detail: `${index.indexedDocuments} indexed documents · ${index.chunksWithVectors}/${index.chunksInDb} chunks embedded`,
      fix: index.missingVectors > 0 ? 'Run: npm run ingest -- --reindex' : undefined,
    });
  } catch {
    // Database already reported as unreachable above.
  }

  console.log('\nGolden Sierra Workforce Navigator — setup check\n');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name.padEnd(20)} ${check.detail}`);
    if (check.fix) console.log(`      → ${check.fix}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? '\nEverything is ready. Start with: npm run dev\n'
      : `\n${failed.length} item(s) need attention before the app will work fully.\n`,
  );

  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Setup check failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
