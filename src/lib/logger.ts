import { env } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = env.NODE_ENV === 'production' ? ORDER.info : ORDER.debug;

/** Keys whose values are redacted wherever they appear in log context. */
const SECRET_KEYS = /^(.*(key|token|secret|password|authorization|cookie).*)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < MIN) return;
  const line = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  /** Child logger that stamps every line with shared context (e.g. a jobId). */
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: Record<string, unknown>) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: Record<string, unknown>) => emit('error', m, { ...base, ...c }),
    };
  },
};
