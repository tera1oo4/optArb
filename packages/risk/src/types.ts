import type { Decimal, Underlying, Venue } from '@optarb/core';

/** Read-only exposure bucket used by the risk engine (venue or underlying). */
export interface RiskExposure {
  key: string;
  notionalUsd: Decimal;
}

/** Read-only open position summary used by the risk engine. */
export interface RiskPosition {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  /** Signed coin notional: positive = long, negative = short. */
  qty: Decimal;
  /** Absolute mark-to-market notional in USD. */
  notionalUsd: Decimal;
}

/**
 * Snapshot of current risk-relevant state passed to RiskEngine.check.
 * The trader maps this from the paper portfolio snapshot so the risk package
 * stays decoupled from portfolio internals.
 */
export interface RiskState {
  positions: RiskPosition[];
  perVenue: RiskExposure[];
  perUnderlying: RiskExposure[];
  /** Σ |qty| × mark across open positions. */
  grossNotionalUsd: Decimal;
  /**
   * Realized PnL accumulated since the start of the trading day. For the paper
   * trader this is currently the cumulative realized PnL since process start;
   * a production deployment would reset it at the session rollover.
   */
  dailyRealizedPnlUsd: Decimal;
}

/** Result of a pre-trade risk check. */
export interface RiskCheckResult {
  allowed: boolean;
  reasons: string[];
}
