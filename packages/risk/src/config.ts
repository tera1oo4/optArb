import { z } from 'zod';
import { dec, decimalString } from '@optarb/core';

/**
 * Money / bps limit parsed as Decimal (ADR-0002: no float in financial
 * config). Accepts numbers or numeric strings from env, test fixtures, or
 * app configs and normalises them to Decimal.
 */
const decimalLimit = (def: string) =>
  z.preprocess(
    (v) => (v === undefined || v === null ? def : String(v)),
    decimalString.transform((s) => dec(s)),
  );

/**
 * Optional money limit: empty/unset means "no limit". Used for the
 * greeks/margin/settlement caps that only apply when the deployment
 * provides the corresponding state.
 */
const decimalLimitOpt = () =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? undefined : String(v)),
    decimalString.optional().transform((s) => (s === undefined ? undefined : dec(s))),
  );

/**
 * Pre-trade risk configuration loaded from environment variables (ADR-0006).
 * Merged into apps/trader/src/config.ts and apps/backtest/src/config.ts.
 *
 * Money and bps limits are Decimal (ADR-0002); millisecond timeouts stay
 * plain numbers because they never enter financial arithmetic.
 */
export const RiskConfigSchema = z.object({
  RISK_MAX_NOTIONAL_PER_TRADE_USD: decimalLimit('10000'),
  RISK_MAX_NOTIONAL_PER_VENUE_USD: decimalLimit('50000'),
  RISK_MAX_NOTIONAL_GLOBAL_USD: decimalLimit('200000'),
  RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: decimalLimit('100000'),
  RISK_MAX_DAILY_LOSS_USD: decimalLimit('5000'),
  /**
   * Max daily drawdown on realized + unrealized − fees. RISK_MAX_DAILY_LOSS_USD
   * only sees closed trades, so a stuck unhedged leg can bleed indefinitely
   * without tripping it; this limit marks the book to market instead.
   */
  RISK_MAX_DAILY_DRAWDOWN_USD: decimalLimit('7500'),
  RISK_MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(2_000),
  RISK_MIN_EDGE_AFTER_FEES_BPS: decimalLimit('5'),
  /**
   * Max divergence between the two legs' venue index prices (bps). A cross-venue
   * "spread" that is really just two venues printing different index prices is a
   * phantom edge, not a mispricing — reject it. Only applies when both legs carry
   * an index (option venues); Polymarket legs (null index) skip this check.
   */
  RISK_MAX_INDEX_DIVERGENCE_BPS: decimalLimit('30'),
  /** Max age difference between the two legs' quotes (ms); guards stale-leg risk. */
  RISK_MAX_LEG_SKEW_MS: z.coerce.number().int().nonnegative().default(500),
  RISK_KILL_SWITCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Greeks exposure caps per underlying (ADR-0006). Enforced only when the
   * RiskState carries greeks for that underlying; absent data skips the check
   * (the paper portfolio does not track greeks yet — see ADR-0007).
   * Units: delta in coin, vega/gamma in USD.
   */
  RISK_MAX_DELTA_PER_UNDERLYING: decimalLimitOpt(),
  RISK_MAX_VEGA_PER_UNDERLYING_USD: decimalLimitOpt(),
  RISK_MAX_GAMMA_PER_UNDERLYING_USD: decimalLimitOpt(),
  /**
   * Minimum margin headroom in USD. When the state reports headroom below
   * this (e.g. negative = margin call territory), new intents are denied.
   * Unset = no margin check.
   */
  RISK_MIN_MARGIN_HEADROOM_USD: decimalLimitOpt(),
  /**
   * Max unsettled Polymarket exposure in USD (open + new intent notional on
   * Polymarket legs). Caps the amount locked until binary settlement.
   * Unset = no settlement-risk cap.
   */
  RISK_MAX_POLYMARKET_SETTLEMENT_USD: decimalLimitOpt(),

  /**
   * Auto kill-switch tripwires (ADR-0007). The AutoKillSwitch latches active
   * when any tripwire fires; only an operator reset clears it.
   */
  /** No market message from a venue for this long → trip (heartbeat loss). */
  RISK_AUTO_KILL_HEARTBEAT_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  /** This many book sequence gaps inside the window → trip. */
  RISK_AUTO_KILL_SEQUENCE_GAPS: z.coerce.number().int().positive().default(3),
  RISK_AUTO_KILL_SEQUENCE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** This many exchange rejects inside the window → trip (reject spike). */
  RISK_AUTO_KILL_REJECT_COUNT: z.coerce.number().int().positive().default(5),
  RISK_AUTO_KILL_REJECT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export type RiskConfig = z.infer<typeof RiskConfigSchema>;
