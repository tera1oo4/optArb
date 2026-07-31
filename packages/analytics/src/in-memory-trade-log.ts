import { dec, type Venue } from '@optarb/core';
import type { OrderAttempt, PaperFill, PortfolioSnapshot } from '@optarb/execution';
import type {
  InMemoryTradeLogInput,
  OrderRecord,
  PortfolioSnapshotRecord,
  RiskDecisionInput,
  TradeFill,
  TradeLog,
} from './types.js';

function mapAttemptStatus(status: OrderAttempt['status']): OrderRecord['status'] {
  if (status === 'filled') return 'executed';
  if (status === 'rejected' || status === 'cancelled' || status === 'expired') return 'rejected';
  return 'pending';
}

function toOrderRecord(attempt: OrderAttempt): OrderRecord {
  const buyLeg = attempt.legs.find((l) => l.side === 'buy');
  const sellLeg = attempt.legs.find((l) => l.side === 'sell');
  let requestedNotionalUsd = dec(0);
  for (const leg of attempt.legs) {
    requestedNotionalUsd = requestedNotionalUsd.add(
      leg.requestedPriceUsd.mul(leg.requestedSizeCoin),
    );
  }
  return {
    signalId: attempt.signalId,
    signalKind: attempt.signalKind,
    venueBuy: (buyLeg?.venue ?? attempt.legs[0]!.venue) as Venue,
    venueSell: (sellLeg?.venue ?? attempt.legs[1]!.venue) as Venue,
    requestedNotionalUsd,
    status: mapAttemptStatus(attempt.status),
    createdAtMs: attempt.createdAt,
  };
}

function inferOrdersFromFills(fills: TradeFill[]): OrderRecord[] {
  const bySignal = new Map<string, TradeFill[]>();
  for (const fill of fills) {
    const list = bySignal.get(fill.signalId);
    if (list) {
      list.push(fill);
    } else {
      bySignal.set(fill.signalId, [fill]);
    }
  }
  const orders: OrderRecord[] = [];
  for (const [signalId, signalFills] of bySignal.entries()) {
    const buy = signalFills.find((f) => f.side === 'buy');
    const sell = signalFills.find((f) => f.side === 'sell');
    const firstTs = signalFills[0]!.tsMs;
    const requestedNotionalUsd = signalFills.reduce(
      (sum, f) => sum.add(f.notionalUsd.abs()),
      dec(0),
    );
    orders.push({
      signalId,
      signalKind: 'cross-venue',
      venueBuy: (buy?.venue ?? signalFills[0]!.venue) as Venue,
      venueSell: (sell?.venue ?? signalFills[0]!.venue) as Venue,
      requestedNotionalUsd,
      status: 'executed',
      createdAtMs: firstTs,
    });
  }
  return orders;
}

export class InMemoryTradeLog implements TradeLog {
  private readonly orders: OrderRecord[];
  private readonly fills: TradeFill[];
  private readonly decisions: RiskDecisionInput[];
  private readonly snapshots: PortfolioSnapshotRecord[];

  constructor(input: InMemoryTradeLogInput = {}) {
    this.fills = input.fills ? [...input.fills] : [];
    this.orders =
      input.orders && input.orders.length > 0
        ? input.orders.map(toOrderRecord)
        : inferOrdersFromFills(this.fills);
    this.decisions = input.riskDecisions ? [...input.riskDecisions] : [];
    this.snapshots = input.portfolioSnapshots ? [...input.portfolioSnapshots] : [];
  }

  async getOrders(): Promise<OrderRecord[]> {
    return this.orders;
  }

  async getFills(): Promise<TradeFill[]> {
    return this.fills;
  }

  async getRiskDecisions(): Promise<RiskDecisionInput[]> {
    return this.decisions;
  }

  async getPortfolioSnapshots(): Promise<PortfolioSnapshotRecord[]> {
    return this.snapshots;
  }
}
