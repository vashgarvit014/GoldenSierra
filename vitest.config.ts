import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Writes synthetic rows to the live stores; run explicitly with `npm run test:integration`.
    exclude: ['tests/integration/ingest-consistency.test.ts', 'node_modules/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
