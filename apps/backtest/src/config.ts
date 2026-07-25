import { z } from 'zod';
import { RiskConfigSchema } from '@optarb/risk';

const VenueEnum = z.enum(['deribit', 'bybit', 'okx', 'binance', 'polymarket']);

const decimalString = z.string().refine(
  (s) => {
    try {
      // eslint-disable-next-line no-new
      new globalThis.Number(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a decimal number string' },
);

const EnvSchema = z
  .object({
    /** Cross-venue detector thresholds */
    SIGNAL_MIN_SPREAD_BPS: z.coerce.number().positive().default(25),
    SIGNAL_MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(2_000),
    SIGNAL_MIN_SIZE_USD: z.coerce.number().positive().default(1_000),

    /** Backtest engine timing */
    SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    PAPER_REPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

    /** Paper execution limits (ADR-0006) */
    PAPER_MAX_NOTIONAL_USD: z.coerce.number().positive().default(10_000),

    /** Optional per-venue fee overrides for paper PnL (fractions, e.g. 0.0003) */
    PAPER_FEE_DERIBIT_TAKER_RATE: decimalString.optional(),
    PAPER_FEE_DERIBIT_CAP_FRACTION: decimalString.optional(),
    PAPER_FEE_BYBIT_TAKER_RATE: decimalString.optional(),
    PAPER_FEE_BYBIT_CAP_FRACTION: decimalString.optional(),
    PAPER_FEE_OKX_TAKER_RATE: decimalString.optional(),
    PAPER_FEE_OKX_CAP_FRACTION: decimalString.optional(),
    PAPER_FEE_BINANCE_TAKER_RATE: decimalString.optional(),
    PAPER_FEE_BINANCE_CAP_FRACTION: decimalString.optional(),
    PAPER_FEE_POLYMARKET_TAKER_RATE: decimalString.optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .merge(RiskConfigSchema);

export type BacktestConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BacktestConfig {
  return EnvSchema.parse(env);
}
