/**
 * Test bootstrap. Loads .env so modules that validate configuration at import
 * time can load, then supplies safe fallbacks for anything still missing, so
 * unit tests run on a machine with no local services configured.
 */
import { config } from 'dotenv';

config({ path: '.env', quiet: true });

process.env.DATABASE_URL ??= 'postgresql://gs:gs@localhost:5433/goldensierra?schema=public';
process.env.AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';
process.env.QDRANT_URL ??= 'http://localhost:6333';
// NODE_ENV is typed read-only by @types/node; assign through the record.
(process.env as Record<string, string>).NODE_ENV = 'test';
