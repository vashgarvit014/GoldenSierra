import { env } from './env';
import { tooManyRequests } from './errors';
import { logger } from './logger';

/**
 * Fixed-window limiter. In-memory by default; backed by Redis when REDIS_URL is
 * set so limits hold across instances. Keys are hashed identifiers, never raw IPs.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Keep the in-memory map from growing without bound on a long-lived process.
let lastSweep = Date.now();
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

export async function checkRateLimit(
  key: string,
  limit = env.CHAT_RATE_LIMIT_PER_MIN,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const now = Date.now();
  sweep(now);

  const redis = await getRedis();
  if (redis) {
    try {
      const windowKey = `rl:${key}:${Math.floor(now / windowMs)}`;
      const count = await redis.incr(windowKey);
      if (count === 1) await redis.pexpire(windowKey, windowMs);
      const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (err) {
      // Rate limiting is a guard rail, not a dependency. If the store is
      // unreachable the request still proceeds, counted in memory.
      redisUnavailable = true;
      logger.warn('Redis rate-limit check failed; counting in memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
  };
}

export async function enforceRateLimit(key: string, limit?: number): Promise<void> {
  const result = await checkRateLimit(key, limit);
  if (!result.allowed) {
    const seconds = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw tooManyRequests(`Too many requests. Please wait ${seconds}s and try again.`);
  }
}

/** Lazily-created shared Redis connection; null when Redis isn't configured. */
let redisPromise: Promise<RedisLike | null> | undefined;

type RedisLike = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
};

/**
 * Set once Redis has proved unreachable, so we stop retrying it for the life
 * of the process and serve every subsequent request from the in-memory
 * limiter instead.
 */
let redisUnavailable = false;

async function getRedis(): Promise<RedisLike | null> {
  if (!env.REDIS_URL || redisUnavailable) return null;

  redisPromise ??= (async () => {
    try {
      const { default: Redis } = await import('ioredis');
      const client = new Redis(env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        lazyConnect: false,
        // Give up quickly rather than reconnecting forever behind every request.
        retryStrategy: (times) => (times > 2 ? null : 200),
      });

      // ioredis emits 'error' on an unreachable server. Without a listener
      // Node treats it as an unhandled error event, which took down the whole
      // request — a rate limiter must never be able to do that.
      client.on('error', (err: Error) => {
        if (!redisUnavailable) {
          redisUnavailable = true;
          logger.warn('Redis unreachable; falling back to in-memory rate limiting', {
            error: err.message,
          });
        }
      });

      return client as unknown as RedisLike;
    } catch (err) {
      redisUnavailable = true;
      logger.warn('Could not load the Redis client; using in-memory rate limiting', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();

  return redisPromise;
}

/** Stable, non-reversible client identifier for rate-limit keys and logs. */
export async function hashIdentifier(value: string): Promise<string> {
  const data = new TextEncoder().encode(`${value}:${env.AUTH_SECRET ?? 'gs'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function clientIpFrom(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
