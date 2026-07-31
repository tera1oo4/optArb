import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@optarb/core': r('./packages/core/src/index.ts'),
      '@optarb/persistence': r('./packages/persistence/src/index.ts'),
      '@optarb/venue-deribit': r('./packages/venues/deribit/src/index.ts'),
      '@optarb/venue-bybit': r('./packages/venues/bybit/src/index.ts'),
      '@optarb/venue-okx': r('./packages/venues/okx/src/index.ts'),
      '@optarb/venue-binance': r('./packages/venues/binance/src/index.ts'),
      '@optarb/venue-polymarket': r('./packages/venues/polymarket/src/index.ts'),
      '@optarb/marketdata': r('./packages/marketdata/src/index.ts'),
      '@optarb/pricing': r('./packages/pricing/src/index.ts'),
      '@optarb/signals': r('./packages/signals/src/index.ts'),
      '@optarb/execution': r('./packages/execution/src/index.ts'),
      '@optarb/risk': r('./packages/risk/src/index.ts'),
      '@optarb/backtest-engine': r('./packages/backtest-engine/src/index.ts'),
      '@optarb/analytics': r('./packages/analytics/src/index.ts'),
      '@optarb/venues': r('./packages/venues/all/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
