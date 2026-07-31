import type { Decimal, Side, Underlying, Venue } from '@optarb/core';
import type { OrderAttempt, PaperFill, PortfolioSnapshot } from '@optarb/execution';

/**
 * Normalised fill record used by analytics.  It is compatible with
 * {@link PaperFill} but the Postgres source may reconstruct missing optional
 * fields (view key / underlying) from the instrument id.
 */
export interface TradeFill extends PaperFill {}

export interface RiskDecisionInput {
  signalId: string;
  allowed: boolean;
  reasons: string[];
  checkedAtMs: number;
}

export interface OrderRecord {
  signalId: string;
  signalKind: string;
  venueBuy: Venue;
  venueSell: Venue;
  requestedNotionalUsd: Decimal;
  status: 'executed' | 'rejected' | 'pending' | OrderAttempt['status'];
  createdAtMs: number;
}

export interface PortfolioSnapshotRecord extends PortfolioSnapshot {
  tsMs: number;
}

export interface InMemoryTradeLogInput {
  fills?: PaperFill[];
  orders?: OrderAttempt[];
  riskDecisions?: RiskDecisionInput[];
  portfolioSnapshots?: PortfolioSnapshotRecord[];
}

export interface TradeLog {
  getOrders(): Promise<OrderRecord[]>;
  getFills(): Promise<TradeFill[]>;
  getRiskDecisions(): Promise<RiskDecisionInput[]>;
  getPortfolioSnapshots(): Promise<PortfolioSnapshotRecord[]>;
}

export interface PeriodFilter {
  from?: Date;
  to?: Date;
}

export interface VenueMetrics {
  fills: number;
  grossNotionalUsd: Decimal;
  feesUsd: Decimal;
  netPnlUsd: Decimal;
}

export interface UnderlyingMetrics {
  fills: number;
  grossNotionalUsd: Decimal;
  feesUsd: Decimal;
  netPnlUsd: Decimal;
}

export interface DetectorMetrics {
  signals: number;
  executed: number;
  rejected: number;
  fills: number;
  grossPnlUsd: Decimal;
  feesUsd: Decimal;
  netPnlUsd: Decimal;
  winRate: Decimal | null;
}

export interface Report {
  period: { from?: Date; to?: Date };
  totalSignals: number;
  totalFills: number;
  totalRiskRejects: number;
  rejectRate: Decimal | null;
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  avgPnlPerFill: Decimal;
  winRate: Decimal | null;
  avgEdgeAfterFeesBps: Decimal | null;
  maxDrawdown: Decimal;
  sharpe: Decimal | null;
  perVenue: Partial<Record<Venue, VenueMetrics>>;
  perUnderlying: Partial<Record<Underlying, UnderlyingMetrics>>;
  perDetector: Record<string, DetectorMetrics>;
  horizonHitRate: Decimal | null;
}

export interface MetricDelta {
  absolute: Decimal;
  percent: Decimal | null;
}

export interface Comparison {
  metrics: string[];
  a: Report;
  b: Report;
  deltas: Record<string, MetricDelta>;
}
