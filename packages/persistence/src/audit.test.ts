import { describe, expect, it } from 'vitest';
import { dec, noopLogger } from '@optarb/core';
import {
  createAuditWriter,
  netSide,
  NoOpAuditWriter,
  numeric,
  positionToRow,
  type AuditPositionInput,
} from './audit.js';

describe('numeric', () => {
  it('returns decimal string for positive value', () => {
    expect(numeric(dec('123.456'))).toBe('123.456');
  });

  it('returns decimal string for zero', () => {
    expect(numeric(dec(0))).toBe('0');
  });

  it('returns decimal string for negative value', () => {
    expect(numeric(dec('-0.0001'))).toBe('-0.0001');
  });
});

describe('netSide', () => {
  it('returns long for positive qty', () => {
    expect(netSide(dec('1.5'))).toBe('long');
  });

  it('returns long for zero qty', () => {
    expect(netSide(dec(0))).toBe('long');
  });

  it('returns short for negative qty', () => {
    expect(netSide(dec('-2'))).toBe('short');
  });
});

describe('positionToRow', () => {
  it('maps position to postgres row fields', () => {
    const position: AuditPositionInput = {
      venue: 'deribit',
      instrumentId: 'BTC-26SEP26-100000-C',
      viewKey: 'BTC:CALL:2026-09-26:100000',
      underlying: 'BTC',
      qty: dec('-0.5'),
      avgEntryUsd: dec('1234.56'),
      markUsd: dec('1200'),
      notionalUsd: dec('600'),
      unrealizedPnlUsd: dec('17.28'),
      realizedPnlUsd: dec('0'),
      feesPaidUsd: dec('1.5'),
    };

    const row = positionToRow(position);
    expect(row.venue).toBe('deribit');
    expect(row.instrument_id).toBe('BTC-26SEP26-100000-C');
    expect(row.side).toBe('short');
    expect(row.size_coin).toBe('0.5');
    expect(row.avg_entry_usd).toBe('1234.56');
    expect(row.realized_pnl_usd).toBe('0');
    expect(row.unrealized_pnl_usd).toBe('17.28');
    expect(typeof row.updated_at).toBe('string');
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('NoOpAuditWriter', () => {
  it('resolves all methods without side effects', async () => {
    const writer = new NoOpAuditWriter();

    const orderId = await writer.writeOrder({
      signalId: 's1',
      signalKind: 'cross-venue',
      venueBuy: 'deribit',
      venueSell: 'okx',
      requestedNotionalUsd: dec('1000'),
      status: 'executed',
    });
    expect(orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    await expect(
      writer.writeFills(orderId, [
        {
          signalId: 's1',
          tsMs: Date.now(),
          venue: 'deribit',
          instrumentId: 'i1',
          viewKey: 'k1',
          underlying: 'BTC',
          side: 'buy',
          priceUsd: dec('100'),
          sizeCoin: dec('1'),
          notionalUsd: dec('100'),
          feeUsd: dec('0.1'),
        },
      ]),
    ).resolves.toBeUndefined();

    await expect(
      writer.writePosition({
        venue: 'deribit',
        instrumentId: 'i1',
        viewKey: 'k1',
        underlying: 'BTC',
        qty: dec('1'),
        avgEntryUsd: dec('100'),
        markUsd: dec('101'),
        notionalUsd: dec('101'),
        unrealizedPnlUsd: dec('1'),
        realizedPnlUsd: dec('0'),
        feesPaidUsd: dec('0.1'),
      }),
    ).resolves.toBeUndefined();

    await expect(
      writer.writeRiskDecision({
        signalId: 's1',
        allowed: false,
        reasons: ['too big'],
        checkedAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    await expect(
      writer.writePortfolioSnapshot({
        totalNotionalUsd: dec('1000'),
        realizedPnlUsd: dec('0'),
        unrealizedPnlUsd: dec('10'),
        feesUsd: dec('1'),
        netPnlUsd: dec('9'),
        positions: [],
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    await expect(writer.close()).resolves.toBeUndefined();
  });
});

describe('createAuditWriter', () => {
  it('returns NoOp writer when PERSIST_POSTGRES_URL is unset', () => {
    const writer = createAuditWriter({}, noopLogger);
    expect(writer).toBeInstanceOf(NoOpAuditWriter);
  });

  it('returns Postgres writer when PERSIST_POSTGRES_URL is set', () => {
    const writer = createAuditWriter(
      { PERSIST_POSTGRES_URL: 'postgresql://user:pass@localhost/db' },
      noopLogger,
    );
    expect(writer.constructor.name).toBe('PostgresAuditWriter');
    void writer.close();
  });
});
