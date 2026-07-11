import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@optarb/core': r('./packages/core/src/index.ts'),
      '@optarb/persistence': r('./packages/persistence/src/index.ts'),
      '@optarb/venue-deribit': r('./packages/venues/deribit/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
