import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, withErrorHandling } from '@/lib/errors';
import { recordAudit, requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { recommendedChunking } from '@/lib/ingest/chunk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Runtime-tunable settings. API keys and base URLs are NOT editable here —
 * credentials belong in the environment, where they are not readable through
 * an HTTP endpoint. This surface covers retrieval and response tuning only.
 */
const TUNABLE = {
  RETRIEVAL_TOP_K: z.number().int().min(4).max(100),
  RETRIEVAL_FINAL_K: z.number().int().min(1).max(20),
  RETRIEVAL_MIN_SCORE: z.number().min(0).max(1),
  RERANK_ENABLED: z.boolean(),
  HYBRID_KEYWORD_WEIGHT: z.number().min(0).max(1),
  CHUNK_SIZE: z.number().int().min(200).max(4000),
  CHUNK_OVERLAP: z.number().int().min(0).max(800),
  LLM_TEMPERATURE: z.number().min(0).max(2),
  LLM_MAX_TOKENS: z.number().int().min(200).max(8000),
  RESPONSE_MAX_WORDS: z.number().int().min(80).max(800),
  RESPONSE_MAX_RECOMMENDATIONS: z.number().int().min(1).max(8),
} as const;

export const GET = withErrorHandling(async () => {
  await requireAdmin(AdminRole.VIEWER);

  const overrides = await prisma.systemConfig.findMany();
  const overrideMap = Object.fromEntries(overrides.map((o) => [o.key, o.value]));

  return NextResponse.json({
    // Effective values: environment defaults with any stored override applied.
    effective: {
      RETRIEVAL_TOP_K: overrideMap.RETRIEVAL_TOP_K ?? env.RETRIEVAL_TOP_K,
      RETRIEVAL_FINAL_K: overrideMap.RETRIEVAL_FINAL_K ?? env.RETRIEVAL_FINAL_K,
      RETRIEVAL_MIN_SCORE: overrideMap.RETRIEVAL_MIN_SCORE ?? env.RETRIEVAL_MIN_SCORE,
      RERANK_ENABLED: overrideMap.RERANK_ENABLED ?? env.RERANK_ENABLED,
      HYBRID_KEYWORD_WEIGHT: overrideMap.HYBRID_KEYWORD_WEIGHT ?? env.HYBRID_KEYWORD_WEIGHT,
      CHUNK_SIZE: overrideMap.CHUNK_SIZE ?? env.CHUNK_SIZE,
      CHUNK_OVERLAP: overrideMap.CHUNK_OVERLAP ?? env.CHUNK_OVERLAP,
      LLM_TEMPERATURE: overrideMap.LLM_TEMPERATURE ?? env.LLM_TEMPERATURE,
      LLM_MAX_TOKENS: overrideMap.LLM_MAX_TOKENS ?? env.LLM_MAX_TOKENS,
    },
    // Read-only: changing these means changing the environment and redeploying.
    readOnly: {
      LLM_PROVIDER: env.LLM_PROVIDER,
      LLM_MODEL: env.LLM_MODEL,
      LLM_BASE_URL: env.LLM_BASE_URL,
      EMBEDDING_MODEL: env.EMBEDDING_MODEL,
      EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS,
      EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL,
      QDRANT_COLLECTION: env.QDRANT_COLLECTION,
      CRAWL_ALLOWED_HOSTS: env.CRAWL_ALLOWED_HOSTS,
    },
    chunkingAdvice: recommendedChunking(env.EMBEDDING_MODEL),
    overrides: overrideMap,
  });
});

export const PUT = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin(AdminRole.ADMIN);

  const json = await request.json().catch(() => {
    throw badRequest('Request body must be valid JSON');
  });
  const body = z.record(z.string(), z.unknown()).parse(json);

  const applied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const schema = TUNABLE[key as keyof typeof TUNABLE];
    if (!schema) throw badRequest(`"${key}" is not a tunable setting`);

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw badRequest(`"${key}" is invalid: ${parsed.error.issues[0]?.message ?? 'out of range'}`);
    }

    await prisma.systemConfig.upsert({
      where: { key },
      create: { key, value: parsed.data as never, updatedBy: session.userId },
      update: { value: parsed.data as never, updatedBy: session.userId },
    });
    applied[key] = parsed.data;
  }

  await recordAudit(session.userId, 'update_config', 'SystemConfig', null, applied);

  return NextResponse.json({
    applied,
    note: 'Changes to CHUNK_SIZE or CHUNK_OVERLAP only affect documents indexed after a re-index.',
  });
});
