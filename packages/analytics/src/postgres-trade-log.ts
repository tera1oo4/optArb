import { dec, type Decimal, type Underlying, type Venue } from '@optarb/core';
import type { PortfolioSnapshot, PositionReport } from '@optarb/execution';
import pg from 'pg';
import type {
  OrderRecord,
  PeriodFilter,
  PortfolioSnapshotRecord,
  RiskDecisionInput,
  TradeFill,
  TradeLog,
} from './types.js';

const { Pool } = pg;

interface QueryFilter {
  from?: Date;
  to?: Date;
}

function inferUnderlying(instrumentId: string): Underlying | null {
  const id = instrumentId.toUpperCase();
  if (id.includes('BTC')) return 'BTC';
  if (id.includes('ETH')) return 'ETH';
  return null;
}

function parseDecimal(value: unknown): Decimal {
  if (value === null || value === undefined) return dec(0);
  return dec(String(value));
}

export class PostgresTradeLog implements TradeLog {
  private readonly pool: pg.Pool;
  private readonly filter: QueryFilter;

  constructor(connectionString: string, filter: QueryFilter = {}) {
    this.pool = new Pool({ connectionString });
    this.filter = filter;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getOrders(): Promise<OrderRecord[]> {
    const { text, values } = this.buildQuery(`
      SELECT signal_id, signal_kind, venue_buy, venue_sell, requested_notional_usd, status, created_at
      FROM orders
    `);
    const result = await this.pool.query<{
      signal_id: string;
      signal_kind: string;
      venue_buy: string;
      venue_sell: string;
      requested_notional_usd: string;
      status: string;
      created_at: Date;
    }>(text, values);
    return result.rows.map((r) => ({
      signalId: r.signal_id,
      signalKind: r.signal_kind,
      venueBuy: r.venue_buy as Venue,
      venueSell: r.venue_sell as Venue,
      requestedNotionalUsd: parseDecimal(r.requested_notional_usd),
      status: r.status as OrderRecord['status'],
      createdAtMs: r.created_at.getTime(),
    }));
  }

  async getFills(): Promise<TradeFill[]> {
    const { text, values } = this.buildQuery(`
      SELECT f.venue, f.instrument_id, f.side, f.price_usd, f.size_coin, f.fee_usd, f.notional_usd, f.created_at,
             o.signal_id, o.signal_kind
      FROM fills f
      JOIN orders o ON f.order_id = o.id
    `);
    const result = await this.pool.query<{
      venue: string;
      instrument_id: string;
      side: string;
      price_usd: string;
      size_coin: string;
      fee_usd: string;
      notional_usd: string;
      created_at: Date;
      signal_id: string;
      signal_kind: string;
    }>(text, values);
    return result.rows.map((r) => {
      const underlying = inferUnderlying(r.instrument_id);
      return {
        signalId: r.signal_id,
        tsMs: r.created_at.getTime(),
        venue: r.venue as Venue,
        instrumentId: r.instrument_id,
        viewKey: r.instrument_id,
        underlying: underlying ?? ('BTC' as Underlying),
        side: r.side as 'buy' | 'sell',
        priceUsd: parseDecimal(r.price_usd),
        sizeCoin: parseDecimal(r.size_coin),
        notionalUsd: parseDecimal(r.notional_usd),
        feeUsd: parseDecimal(r.fee_usd),
      };
    });
  }

  async getRiskDecisions(): Promise<RiskDecisionInput[]> {
    const { text, values } = this.buildQuery(`
      SELECT signal_id, allowed, reasons, checked_at
      FROM risk_decisions
    `);
    const result = await this.pool.query<{
      signal_id: string;
      allowed: boolean;
      reasons: string[];
      checked_at: Date;
    }>(text, values);
    return result.rows.map((r) => ({
      signalId: r.signal_id,
      allowed: r.allowed,
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
      checkedAtMs: r.checked_at.getTime(),
    }));
  }

  async getPortfolioSnapshots(): Promise<PortfolioSnapshotRecord[]> {
    const { text, values } = this.buildQuery(`
      SELECT total_notional_usd, realized_pnl_usd, unrealized_pnl_usd, fees_usd, net_pnl_usd, positions, created_at
      FROM portfolio_snapshots
    `);
    const result = await this.pool.query<{
      total_notional_usd: string;
      realized_pnl_usd: string;
      unrealized_pnl_usd: string;
      fees_usd: string;
      net_pnl_usd: string;
      positions: unknown;
      created_at: Date;
    }>(text, values);
    return result.rows.map((r) => this.parseSnapshot(r));
  }

  private parseSnapshot(row: {
    total_notional_usd: string;
    realized_pnl_usd: string;
    unrealized_pnl_usd: string;
    fees_usd: string;
    net_pnl_usd: string;
    positions: unknown;
    created_at: Date;
  }): PortfolioSnapshotRecord {
    const positions = this.parsePositions(row.positions);
    const netPnlUsd = parseDecimal(row.net_pnl_usd);
    return {
      positions,
      perVenue: [],
      perUnderlying: [],
      openPositions: positions.length,
      grossNotionalUsd: parseDecimal(row.total_notional_usd),
      realizedPnlUsd: parseDecimal(row.realized_pnl_usd),
      unrealizedPnlUsd: parseDecimal(row.unrealized_pnl_usd),
      feesPaidUsd: parseDecimal(row.fees_usd),
      netPnlUsd,
      tsMs: row.created_at.getTime(),
    };
  }

  private parsePositions(raw: unknown): PositionReport[] {
    if (!Array.isArray(raw)) return [];
    const out: PositionReport[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      const underlying = inferUnderlying(String(obj.instrument_id ?? obj.instrumentId ?? ''));
      out.push({
        venue: String(obj.venue ?? '') as Venue,
        instrumentId: String(obj.instrument_id ?? obj.instrumentId ?? ''),
        viewKey: String(obj.view_key ?? obj.viewKey ?? obj.instrument_id ?? ''),
        underlying: underlying ?? ('BTC' as Underlying),
        qty: parseDecimal(obj.qty),
        avgEntryUsd: parseDecimal(obj.avg_entry_usd ?? obj.avgEntryUsd),
        markUsd: parseDecimal(obj.mark_usd ?? obj.markUsd),
        notionalUsd: parseDecimal(obj.notional_usd ?? obj.notionalUsd),
        unrealizedPnlUsd: parseDecimal(obj.unrealized_pnl_usd ?? obj.unrealizedPnlUsd),
        realizedPnlUsd: parseDecimal(obj.realized_pnl_usd ?? obj.realizedPnlUsd),
        feesPaidUsd: parseDecimal(obj.fees_paid_usd ?? obj.feesPaidUsd),
      });
    }
    return out;
  }

  private buildQuery(baseSql: string): { text: string; values: (Date | string)[] } {
    const clauses: string[] = [];
    const values: (Date | string)[] = [];
    if (this.filter.from) {
      values.push(this.filter.from);
      clauses.push(`created_at >= $${values.length}`);
    }
    if (this.filter.to) {
      values.push(this.filter.to);
      clauses.push(`created_at < $${values.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return { text: `${baseSql}${where} ORDER BY created_at`, values };
  }
}
