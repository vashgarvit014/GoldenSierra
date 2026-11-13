import { z } from 'zod';

/**
 * Single source of truth for configuration. Parsed once, at import time, so a
 * misconfigured deployment fails loudly at boot rather than mid-conversation.
 *
 * Nothing here is exposed to the browser: every consumer is a server module.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      !v ? def : v.split(',').map((s) => s.trim()).filter(Boolean),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().default('gs_knowledge'),

  REDIS_URL: z.string().optional(),

  LLM_PROVIDER: z.string().default('openai'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_TEMPERATURE: num(0.2),
  LLM_MAX_TOKENS: int(2000),

  // 'local' runs the model in-process via Transformers.js (no API key).
  // Anything else is treated as an OpenAI-compatible HTTP endpoint.
  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('openai'),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: int(1536),
  EMBEDDING_BATCH_SIZE: int(64),

  RETRIEVAL_TOP_K: int(40),
  RETRIEVAL_FINAL_K: int(8),
  RETRIEVAL_MIN_SCORE: num(0.25),
  RERANK_ENABLED: bool(true),
  RERANK_MODEL: z.string().optional(),
  HYBRID_KEYWORD_WEIGHT: num(0.35),

  CHUNK_SIZE: int(900),
  CHUNK_OVERLAP: int(150),

  CRAWL_USER_AGENT: z.string().default('GoldenSierraNavigatorBot/1.0'),
  CRAWL_CONCURRENCY: int(3),
  CRAWL_DELAY_MS: int(800),
  CRAWL_MAX_PAGES: int(300),
  CRAWL_MAX_DEPTH: int(3),
  CRAWL_TIMEOUT_MS: int(30_000),
  CRAWL_RESPECT_ROBOTS: bool(true),
  CRAWL_ALLOWED_HOSTS: csv(['goldensierra.com', 'www.goldensierra.com']),
  FIRECRAWL_API_KEY: z.string().optional(),

  AUTH_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: int(12),
  CHAT_RATE_LIMIT_PER_MIN: int(20),
  MAX_MESSAGE_CHARS: int(2000),
  MAX_UPLOAD_BYTES: int(20 * 1024 * 1024),

  CHAT_RETENTION_DAYS: int(30),
});

type ParsedEnv = z.infer<typeof schema>;

/**
 * Validation is deferred to first access rather than running at import.
 *
 * `next build` imports every route module to collect its metadata, so
 * validating at module scope made a build impossible without production
 * secrets present — which is exactly the situation on a CI or Vercel build
 * step, and it failed there with "Failed to collect configuration for
 * /api/admin/config".
 *
 * Deferring loses nothing: the point of validation is that a misconfigured
 * *deployment* fails loudly instead of halfway through a conversation, and
 * that still holds. `assertEnv()` is called at server start
 * (src/instrumentation.ts) so a bad config fails at boot, not on first use.
 */
let cache: ParsedEnv | undefined;

/** True while `next build` is collecting route metadata. */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function loadEnv(): ParsedEnv {
  if (cache) return cache;

  const parsed = schema.safeParse(process.env);
  if (parsed.success) {
    cache = parsed.data;
    return cache;
  }

  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');

  // A build must not require runtime secrets. Fall back to placeholders so
  // route metadata can be collected; the real values are read at request time.
  if (isBuildPhase()) {
    const relaxed = schema.safeParse({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://build:build@localhost:5432/build',
    });
    if (relaxed.success) {
      cache = relaxed.data;
      return cache;
    }
  }

  throw new Error(`Invalid environment configuration:\n${issues}`);
}

/**
 * Validates now and throws on a bad configuration. Call at server start so a
 * deployment with missing variables fails immediately and visibly.
 */
export function assertEnv(): void {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return;
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

/**
 * Reads like a plain object; each property access resolves through the
 * validated config, loading it on first use.
 */
export const env = new Proxy({} as ParsedEnv, {
  get: (_t, key: string) => loadEnv()[key as keyof ParsedEnv],
  has: (_t, key: string) => key in loadEnv(),
  ownKeys: () => Reflect.ownKeys(loadEnv()),
  getOwnPropertyDescriptor: (_t, key: string) =>
    Object.getOwnPropertyDescriptor(loadEnv(), key),
});

export type Env = ParsedEnv;

/** The LLM needs a key; the app should still boot without one so the admin
 *  dashboard and ingestion tooling remain usable. Callers check this. */
export const hasLlm = () => Boolean(env.LLM_API_KEY);
/** Local embeddings need no credential, so availability depends on provider. */
export const hasEmbeddings = () =>
  env.EMBEDDING_PROVIDER === 'local' || Boolean(env.EMBEDDING_API_KEY || env.LLM_API_KEY);
export const hasRedis = () => Boolean(env.REDIS_URL);

export function requireAuthSecret(): Uint8Array {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    throw new Error(
      'AUTH_SECRET must be set to at least 32 characters. Generate one with: openssl rand -base64 48',
    );
  }
  return new TextEncoder().encode(env.AUTH_SECRET);
}
