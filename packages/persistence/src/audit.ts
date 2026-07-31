import { randomUUID } from 'node:crypto';
import type { Logger, Side, Underlying, Venue } from '@optarb/core';
import type { Decimal } from '@optarb/core';
import pg from 'pg';

const { Pool } = pg;

export interface AuditOrderInput {
  signalId: string;
  signalKind: string;
  venueBuy: Venue;
  venueSell: Venue;
  requestedNotionalUsd: Decimal;
  status: 'executed' | 'rejected' | 'pending';
}

export interface AuditFillInput {
  signalId: string;
  tsMs: number;
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  side: Side;
  priceUsd: Decimal;
  sizeCoin: Decimal;
  notionalUsd: Decimal;
  feeUsd: Decimal;
}

export interface AuditPositionInput {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  qty: Decimal;
  avgEntryUsd: Decimal;
  markUsd: Decimal;
  notionalUsd: Decimal;
  unrealizedPnlUsd: Decimal;
  realizedPnlUsd: Decimal;
  feesPaidUsd: Decimal;
}

export interface AuditRiskDecisionInput {
  signalId: string;
  allowed: boolean;
  reasons: string[];
  checkedAt: Date;
}

export interface AuditPortfolioSnapshotInput {
  totalNotionalUsd: Decimal;
  realizedPnlUsd: Decimal;
  unrealizedPnlUsd: Decimal;
  feesUsd: Decimal;
  netPnlUsd: Decimal;
  positions: AuditPositionInput[];
  createdAt: Date;
}

export interface AuditWriter {
  writeOrder(order: AuditOrderInput): Promise<string>;
  writeFills(orderId: string, fills: AuditFillInput[]): Promise<void>;
  writePosition(position: AuditPositionInput): Promise<void>;
  writeRiskDecision(decision: AuditRiskDecisionInput): Promise<void>;
  writePortfolioSnapshot(snapshot: AuditPortfolioSnapshotInput): Promise<void>;
  /** Connectivity check; NoOp always returns true. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function numeric(d: Decimal): string {
  return d.toString();
}

export function netSide(qty: Decimal): 'long' | 'short' {
  return qty.gte(0) ? 'long' : 'short';
}

export function positionToRow(position: AuditPositionInput): Record<string, unknown> {
  return {
    id: randomUUID(),
    venue: position.venue,
    instrument_id: position.instrumentId,
    side: netSide(position.qty),
    size_coin: numeric(position.qty.abs()),
    avg_entry_usd: numeric(position.avgEntryUsd),
    realized_pnl_usd: numeric(position.realizedPnlUsd),
    unrealized_pnl_usd: numeric(position.unrealizedPnlUsd),
    updated_at: new Date().toISOString(),
  };
}

export class PostgresAuditWriter implements AuditWriter {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({ connectionString });
  }

  async writeOrder(order: AuditOrderInput): Promise<string> {
    const id = randomUUID();
    const text = `
      INSERT INTO orders (id, signal_id, signal_kind, venue_buy, venue_sell, requested_notional_usd, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `;
    const values = [
      id,
      order.signalId,
      order.signalKind,
      order.venueBuy,
      order.venueSell,
      numeric(order.requestedNotionalUsd),
      order.status,
    ];
    await this.query(text, values, 'writeOrder');
    return id;
  }

  async writeFills(orderId: string, fills: AuditFillInput[]): Promise<void> {
    if (fills.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const text = `
        INSERT INTO fills (id, order_id, venue, instrument_id, side, price_usd, size_coin, fee_usd, notional_usd, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      `;
      for (const fill of fills) {
        const values = [
          randomUUID(),
          orderId,
          fill.venue,
          fill.instrumentId,
          fill.side,
          numeric(fill.priceUsd),
          numeric(fill.sizeCoin),
          numeric(fill.feeUsd),
          numeric(fill.notionalUsd),
        ];
        await client.query(text, values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.logError(err, 'writeFills');
    } finally {
      client.release();
    }
  }

  async writePosition(position: AuditPositionInput): Promise<void> {
    const absQty = position.qty.abs();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (absQty.isZero()) {
        await client.query('DELETE FROM positions WHERE venue = $1 AND instrument_id = $2', [
          position.venue,
          position.instrumentId,
        ]);
      } else {
        const text = `
          INSERT INTO positions (id, venue, instrument_id, side, size_coin, avg_entry_usd, realized_pnl_usd, unrealized_pnl_usd, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (venue, instrument_id)
          DO UPDATE SET
            side = EXCLUDED.side,
            size_coin = EXCLUDED.size_coin,
            avg_entry_usd = EXCLUDED.avg_entry_usd,
            realized_pnl_usd = EXCLUDED.realized_pnl_usd,
            unrealized_pnl_usd = EXCLUDED.unrealized_pnl_usd,
            updated_at = NOW()
        `;
        const values = [
          randomUUID(),
          position.venue,
          position.instrumentId,
          netSide(position.qty),
          numeric(absQty),
          numeric(position.avgEntryUsd),
          numeric(position.realizedPnlUsd),
          numeric(position.unrealizedPnlUsd),
        ];
        await client.query(text, values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.logError(err, 'writePosition');
    } finally {
      client.release();
    }
  }

  async writeRiskDecision(decision: AuditRiskDecisionInput): Promise<void> {
    const text = `
      INSERT INTO risk_decisions (id, signal_id, allowed, reasons, checked_at)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const values = [
      randomUUID(),
      decision.signalId,
      decision.allowed,
      JSON.stringify(decision.reasons),
      decision.checkedAt,
    ];
    await this.query(text, values, 'writeRiskDecision');
  }

  async writePortfolioSnapshot(snapshot: AuditPortfolioSnapshotInput): Promise<void> {
    const text = `
      INSERT INTO portfolio_snapshots (id, total_notional_usd, realized_pnl_usd, unrealized_pnl_usd, fees_usd, net_pnl_usd, positions, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    const values = [
      randomUUID(),
      numeric(snapshot.totalNotionalUsd),
      numeric(snapshot.realizedPnlUsd),
      numeric(snapshot.unrealizedPnlUsd),
      numeric(snapshot.feesUsd),
      numeric(snapshot.netPnlUsd),
      JSON.stringify(snapshot.positions.map(positionToJson)),
      snapshot.createdAt,
    ];
    await this.query(text, values, 'writePortfolioSnapshot');
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (err) {
      this.logger.error('PostgresAuditWriter ping failed', { err: String(err) });
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query(text: string, values: unknown[], label: string): Promise<void> {
    try {
      await this.pool.query(text, values);
    } catch (err) {
      this.logError(err, label);
    }
  }

  private logError(err: unknown, label: string): void {
    this.logger.error('PostgresAuditWriter error', { err: String(err), label });
  }
}

export class NoOpAuditWriter implements AuditWriter {
  async writeOrder(_order: AuditOrderInput): Promise<string> {
    return randomUUID();
  }

  async writeFills(_orderId: string, _fills: AuditFillInput[]): Promise<void> {}

  async writePosition(_position: AuditPositionInput): Promise<void> {}

  async writeRiskDecision(_decision: AuditRiskDecisionInput): Promise<void> {}

  async writePortfolioSnapshot(_snapshot: AuditPortfolioSnapshotInput): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export function createAuditWriter(
  env: { PERSIST_POSTGRES_URL?: string },
  logger: Logger,
): AuditWriter {
  if (env.PERSIST_POSTGRES_URL) {
    return new PostgresAuditWriter(env.PERSIST_POSTGRES_URL, logger);
  }
  return new NoOpAuditWriter();
}

function positionToJson(position: AuditPositionInput): Record<string, unknown> {
  return {
    venue: position.venue,
    instrument_id: position.instrumentId,
    view_key: position.viewKey,
    underlying: position.underlying,
    qty: numeric(position.qty),
    avg_entry_usd: numeric(position.avgEntryUsd),
    mark_usd: numeric(position.markUsd),
    notional_usd: numeric(position.notionalUsd),
    unrealized_pnl_usd: numeric(position.unrealizedPnlUsd),
    realized_pnl_usd: numeric(position.realizedPnlUsd),
    fees_paid_usd: numeric(position.feesPaidUsd),
  };
}
