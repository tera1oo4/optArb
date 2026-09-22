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
  /**
   * Mark-to-market PnL since the start of the trading day: realized +
   * unrealized − fees. Catches a losing open leg that dailyRealizedPnlUsd,
   * which only moves when a position is closed, would never see.
   */
  dailyNetPnlUsd: Decimal;
  /**
   * Per-underlying greeks exposure (optional). When present, the engine
   * enforces RISK_MAX_{DELTA,VEGA,GAMMA}_PER_UNDERLYING. Units: delta in
   * coin, vega/gamma in USD.
   */
  greeksPerUnderlying?: GreeksExposure[];
  /** Free margin headroom in USD (optional). Negative = margin call territory. */
  marginHeadroomUsd?: Decimal;
  /** Currently unsettled Polymarket exposure in USD (optional). */
  polymarketSettlementExposureUsd?: Decimal;
}

/** Per-underlying greeks bucket used by the risk engine. */
export interface GreeksExposure {
  underlying: string;
  delta: Decimal;
  vegaUsd: Decimal;
  gammaUsd: Decimal;
}

/** Result of a pre-trade risk check. */
export interface RiskCheckResult {
  allowed: boolean;
  reasons: string[];
}
