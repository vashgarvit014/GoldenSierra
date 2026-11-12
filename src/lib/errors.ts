import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { logger } from './logger';
import { env } from './env';

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = 'internal_error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(m, 400, 'bad_request', d);
export const unauthorized = (m = 'Authentication required') => new AppError(m, 401, 'unauthorized');
export const forbidden = (m = 'You do not have access to this resource') =>
  new AppError(m, 403, 'forbidden');
export const notFound = (m = 'Not found') => new AppError(m, 404, 'not_found');
export const tooManyRequests = (m = 'Too many requests. Please slow down.') =>
  new AppError(m, 429, 'rate_limited');
export const serviceUnavailable = (m: string) => new AppError(m, 503, 'service_unavailable');

/**
 * Converts anything thrown inside a route into a safe JSON response. Internal
 * failures never leak a stack trace or driver message to the client.
 */
export function toErrorResponse(err: unknown, requestId?: string): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Request validation failed',
        code: 'validation_error',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
      { status: 400 },
    );
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code, requestId });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details, requestId },
      { status: err.status },
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unhandled route error', {
    message,
    stack: err instanceof Error ? err.stack : undefined,
    requestId,
  });

  return NextResponse.json(
    {
      error: 'Something went wrong on our end. Please try again.',
      code: 'internal_error',
      requestId,
      ...(env.NODE_ENV === 'development' ? { debug: message } : {}),
    },
    { status: 500 },
  );
}

/** Wraps a route handler with error translation and a correlation id. */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    const requestId = crypto.randomUUID();
    try {
      return await handler(...args);
    } catch (err) {
      return toErrorResponse(err, requestId);
    }
  };
}

/** Runs a promise with a hard timeout so a hung upstream can't pin a request. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(`${label} timed out after ${ms}ms`, 504, 'timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Retries transient failures with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string; retryOn?: (e: unknown) => boolean } = {},
): Promise<T> {
  const { attempts = 3, baseMs = 500, label = 'operation', retryOn } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (retryOn && !retryOn(err)) throw err;
      if (attempt === attempts) break;
      const delay = baseMs * 2 ** (attempt - 1) + Math.random() * baseMs;
      logger.warn(`${label} failed; retrying`, { attempt, attempts, delay: Math.round(delay) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
