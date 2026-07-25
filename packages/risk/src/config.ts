import { z } from 'zod';

/**
 * Pre-trade risk configuration loaded from environment variables (ADR-0006).
 * Merged into apps/trader/src/config.ts.
 */
export const RiskConfigSchema = z.object({
  RISK_MAX_NOTIONAL_PER_TRADE_USD: z.coerce.number().positive().default(10_000),
  RISK_MAX_NOTIONAL_PER_VENUE_USD: z.coerce.number().positive().default(50_000),
  RISK_MAX_NOTIONAL_GLOBAL_USD: z.coerce.number().positive().default(200_000),
  RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: z.coerce.number().positive().default(100_000),
  RISK_MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(5_000),
  RISK_MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(2_000),
  RISK_MIN_EDGE_AFTER_FEES_BPS: z.coerce.number().nonnegative().default(5),
  RISK_KILL_SWITCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type RiskConfig = z.infer<typeof RiskConfigSchema>;
