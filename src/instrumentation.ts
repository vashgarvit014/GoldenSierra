import { assertEnv, env, hasEmbeddings } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Next.js calls this once per server process, before the first request.
 *
 * The local embedding model takes ~30-40s to initialise on a cold process.
 * Paying that inside the first user's question would look like a hang, so it
 * is warmed here in the background — the server starts accepting requests
 * immediately and only embedding-dependent work waits.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Validation moved out of module scope so `next build` does not require
  // production secrets. Enforce it here instead: a deployment missing a
  // variable fails at startup, visibly, rather than on a user's first message.
  assertEnv();
  if (env.EMBEDDING_PROVIDER !== 'local' || !hasEmbeddings()) return;

  logger.info('Warming local embedding model…', { model: env.EMBEDDING_MODEL });
  const started = Date.now();

  // Deliberately not awaited: a slow model load must not block startup.
  void import('@/lib/ai/local-embeddings')
    .then((m) => m.warmLocalEmbeddings())
    .then(() => logger.info('Embedding model warm', { ms: Date.now() - started }))
    .catch((err) =>
      logger.warn('Embedding warmup failed; it will load on first use', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}
