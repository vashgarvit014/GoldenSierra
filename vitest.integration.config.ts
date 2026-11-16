import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Integration tests: real Postgres + Qdrant, synthetic data only, cleans up after itself. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
