import { dec, Decimal, type Underlying, type Venue, VENUES } from '@optarb/core';
import type {
  DetectorMetrics,
  OrderRecord,
  PortfolioSnapshotRecord,
  Report,
  RiskDecisionInput,
  TradeFill,
  UnderlyingMetrics,
  VenueMetrics,
} from './types.js';

interface MetricInput {
  orders: OrderRecord[];
  fills: TradeFill[];
  decisions: RiskDecisionInput[];
  snapshots: PortfolioSnapshotRecord[];
  period?: { from?: Date; to?: Date };
}

const EXECUTED_STATUSES = new Set(['executed', 'filled']);
const REJECTED_STATUSES = new Set(['rejected', 'cancelled', 'expired']);

function signedNotional(fill: TradeFill): Decimal {
  return fill.side === 'sell' ? fill.notionalUsd : fill.notionalUsd.neg();
}

function signalNetPnl(fills: TradeFill[]): Decimal {
  let gross = dec(0);
  let fees = dec(0);
  for (const fill of fills) {
    gross = gross.add(signedNotional(fill));
    fees = fees.add(fill.feeUsd);
  }
  return gross.sub(fees);
}

function signalGrossPnl(fills: TradeFill[]): Decimal {
  let gross = dec(0);
  for (const fill of fills) {
    gross = gross.add(signedNotional(fill));
  }
  return gross;
}

function buyNotional(fills: TradeFill[]): Decimal {
  let sum = dec(0);
  for (const fill of fills) {
    if (fill.side === 'buy') sum = sum.add(fill.notionalUsd);
  }
  return sum;
}

function isExecuted(order: OrderRecord): boolean {
  return EXECUTED_STATUSES.has(order.status);
}

function isRejected(order: OrderRecord): boolean {
  return REJECTED_STATUSES.has(order.status);
}

function groupFillsBySignal(fills: TradeFill[]): Map<string, TradeFill[]> {
  const map = new Map<string, TradeFill[]>();
  for (const fill of fills) {
    const list = map.get(fill.signalId);
    if (list) {
      list.push(fill);
    } else {
      map.set(fill.signalId, [fill]);
    }
  }
  return map;
}

function computeMaxDrawdown(snapshots: PortfolioSnapshotRecord[]): Decimal {
  if (snapshots.length === 0) return dec(0);
  const sorted = [...snapshots].sort((a, b) => a.tsMs - b.tsMs);
  let peak = sorted[0]!.netPnlUsd;
  let maxDd = dec(0);
  for (let i = 1; i < sorted.length; i++) {
    const value = sorted[i]!.netPnlUsd;
    if (value.gt(peak)) {
      peak = value;
    }
    const drawdown = peak.sub(value);
    if (drawdown.gt(maxDd)) {
      maxDd = drawdown;
    }
  }
  return maxDd;
}

/** Per-trade mean / std (population std, no annualization, no risk-free rate). */
function computePerTradeRatio(perTradePnls: Decimal[]): Decimal | null {
  if (perTradePnls.length === 0) return null;
  const n = dec(perTradePnls.length);
  let sum = dec(0);
  for (const p of perTradePnls) {
    sum = sum.add(p);
  }
  const mean = sum.div(n);
  if (perTradePnls.length === 1) return null;
  let sqDiffSum = dec(0);
  for (const p of perTradePnls) {
    sqDiffSum = sqDiffSum.add(p.sub(mean).pow(2));
  }
  const variance = sqDiffSum.div(n);
  const std = Decimal.max(dec(0), variance).sqrt();
  if (std.isZero()) return null;
  return mean.div(std);
}

function inferUnderlying(fill: TradeFill): Underlying | null {
  if (fill.underlying) return fill.underlying;
  const id = fill.instrumentId.toUpperCase();
  if (id.includes('BTC')) return 'BTC';
  if (id.includes('ETH')) return 'ETH';
  return null;
}

export function computeReport(input: MetricInput): Report {
  const { orders, fills, decisions, snapshots, period } = input;

  const totalRiskRejects = decisions.filter((d) => !d.allowed).length;
  const totalSignals = orders.length + totalRiskRejects;

  let grossPnl = dec(0);
  let fees = dec(0);
  for (const fill of fills) {
    grossPnl = grossPnl.add(signedNotional(fill));
    fees = fees.add(fill.feeUsd);
  }
  const netPnl = grossPnl.sub(fees);

  const avgPnlPerFill = fills.length > 0 ? netPnl.div(fills.length) : dec(0);

  const rejectRate = totalSignals > 0 ? dec(totalRiskRejects).div(totalSignals).mul(100) : null;

  const fillsBySignal = groupFillsBySignal(fills);
  let wins = 0;
  const perTradePnls: Decimal[] = [];
  for (const signalFills of fillsBySignal.values()) {
    const pnl = signalNetPnl(signalFills);
    perTradePnls.push(pnl);
    if (pnl.gt(0)) wins++;
  }
  const executedSignals = fillsBySignal.size;
  const winRate = executedSignals > 0 ? dec(wins).div(executedSignals).mul(100) : null;

  const signalKindById = new Map<string, string>();
  for (const order of orders) {
    signalKindById.set(order.signalId, order.signalKind);
  }

  let edgeSum = dec(0);
  let edgeCount = 0;
  for (const [signalId, signalFills] of fillsBySignal.entries()) {
    const kind = signalKindById.get(signalId) ?? 'cross-venue';
    if (kind !== 'cross-venue') continue;
    const bn = buyNotional(signalFills);
    if (bn.lte(0)) continue;
    const edge = signalNetPnl(signalFills).div(bn).mul(10_000);
    edgeSum = edgeSum.add(edge);
    edgeCount++;
  }
  const avgEdgeAfterFeesBps = edgeCount > 0 ? edgeSum.div(edgeCount) : null;

  const maxDrawdown = computeMaxDrawdown(snapshots);
  const perTradeRatio = computePerTradeRatio(perTradePnls);

  const perVenue: Partial<Record<Venue, VenueMetrics>> = {};
  for (const fill of fills) {
    const m = perVenue[fill.venue] ?? {
      fills: 0,
      grossNotionalUsd: dec(0),
      feesUsd: dec(0),
      netPnlUsd: dec(0),
    };
    m.fills++;
    m.grossNotionalUsd = m.grossNotionalUsd.add(fill.notionalUsd.abs());
    m.feesUsd = m.feesUsd.add(fill.feeUsd);
    m.netPnlUsd = m.netPnlUsd.add(signedNotional(fill).sub(fill.feeUsd));
    perVenue[fill.venue] = m;
  }

  const perUnderlying: Partial<Record<Underlying, UnderlyingMetrics>> = {};
  for (const fill of fills) {
    const underlying = inferUnderlying(fill);
    if (!underlying) continue;
    const m = perUnderlying[underlying] ?? {
      fills: 0,
      grossNotionalUsd: dec(0),
      feesUsd: dec(0),
      netPnlUsd: dec(0),
    };
    m.fills++;
    m.grossNotionalUsd = m.grossNotionalUsd.add(fill.notionalUsd.abs());
    m.feesUsd = m.feesUsd.add(fill.feeUsd);
    m.netPnlUsd = m.netPnlUsd.add(signedNotional(fill).sub(fill.feeUsd));
    perUnderlying[underlying] = m;
  }

  const perDetector: Record<string, DetectorMetrics> = {};
  for (const order of orders) {
    const m = perDetector[order.signalKind] ?? {
      signals: 0,
      executed: 0,
      rejected: 0,
      fills: 0,
      grossPnlUsd: dec(0),
      feesUsd: dec(0),
      netPnlUsd: dec(0),
      winRate: null,
    };
    m.signals++;
    if (isExecuted(order)) m.executed++;
    if (isRejected(order)) m.rejected++;
    perDetector[order.signalKind] = m;
  }
  for (const [signalId, signalFills] of fillsBySignal.entries()) {
    const kind = signalKindById.get(signalId) ?? 'cross-venue';
    const m = perDetector[kind] ?? {
      signals: 0,
      executed: 0,
      rejected: 0,
      fills: 0,
      grossPnlUsd: dec(0),
      feesUsd: dec(0),
      netPnlUsd: dec(0),
      winRate: null,
    };
    m.fills += signalFills.length;
    m.grossPnlUsd = m.grossPnlUsd.add(signalGrossPnl(signalFills));
    for (const fill of signalFills) {
      m.feesUsd = m.feesUsd.add(fill.feeUsd);
    }
    m.netPnlUsd = m.netPnlUsd.add(signalNetPnl(signalFills));
    perDetector[kind] = m;
  }
  // Per-detector win-rate calculation.
  for (const kind of Object.keys(perDetector)) {
    const m = perDetector[kind]!;
    let winsKind = 0;
    let countKind = 0;
    for (const [signalId, signalFills] of fillsBySignal.entries()) {
      const signalKind = signalKindById.get(signalId) ?? 'cross-venue';
      if (signalKind !== kind) continue;
      countKind++;
      if (signalNetPnl(signalFills).gt(0)) winsKind++;
    }
    m.winRate = countKind > 0 ? dec(winsKind).div(countKind).mul(100) : null;
  }

  // Ensure all venues appear with zero metrics when there are no fills.
  for (const venue of VENUES) {
    if (!perVenue[venue]) {
      perVenue[venue] = {
        fills: 0,
        grossNotionalUsd: dec(0),
        feesUsd: dec(0),
        netPnlUsd: dec(0),
      };
    }
  }

  return {
    period: period ?? {},
    totalSignals,
    totalFills: fills.length,
    totalRiskRejects,
    rejectRate,
    grossPnl,
    fees,
    netPnl,
    avgPnlPerFill,
    winRate,
    avgEdgeAfterFeesBps,
    maxDrawdown,
    perTradeRatio,
    perVenue,
    perUnderlying,
    perDetector,
    horizonHitRate: null,
  };
}
