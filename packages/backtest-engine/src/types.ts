import type { Decimal, Logger } from '@optarb/core';
import type { FeeSchedules } from '@optarb/execution';
import type { PortfolioSnapshot } from '@optarb/execution';
import type { CrossVenueDetectorConfig } from '@optarb/signals';
import type { RiskConfig } from '@optarb/risk';

export interface BacktestOptions {
  /** Path to the JSONL capture file produced by JsonlCaptureSink. */
  captureFile: string;
  /** Cross-venue detector thresholds. */
  signalConfig: CrossVenueDetectorConfig;
  /** Pre-trade risk limits. */
  riskConfig: RiskConfig;
  /** Per-venue fee schedules for paper PnL. */
  feeSchedules: FeeSchedules;
  /** Max notional in USD per leg; larger intents are scaled down. */
  paperMaxNotionalUsd: Decimal;
  /** Log an intermediate portfolio snapshot every N ms of capture time. */
  reportIntervalMs: number;
  /** Run the signal detector every N ms of capture time (default 1_000). */
  scanIntervalMs?: number;
  /** Optional logger; defaults to pino info. */
  logger?: Logger;
}

export interface BacktestResult {
  rawEntries: number;
  skippedEntries: number;
  gaps: number;
  signalsSeen: number;
  riskRejects: number;
  fills: number;
  finalPortfolioSnapshot: PortfolioSnapshot;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  durationMs: number;
}
