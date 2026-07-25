import { describe, expect, it } from 'vitest';
import { dec, noopLogger } from '@optarb/core';
import { PostgresAuditWriter } from './audit.js';

const databaseUrl = process.env.TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('PostgresAuditWriter integration', () => {
  it('writes and reads back an order', async () => {
    if (!databaseUrl) throw new Error('TEST_POSTGRES_URL is required');
    const writer = new PostgresAuditWriter(databaseUrl, noopLogger);

    const orderId = await writer.writeOrder({
      signalId: 'int-s1',
      signalKind: 'cross-venue',
      venueBuy: 'deribit',
      venueSell: 'okx',
      requestedNotionalUsd: dec('1234.56'),
      status: 'executed',
    });

    expect(orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    await writer.writeFills(orderId, [
      {
        signalId: 'int-s1',
        tsMs: Date.now(),
        venue: 'deribit',
        instrumentId: 'BTC-26SEP26-100000-C',
        viewKey: 'BTC:CALL:2026-09-26:100000',
        underlying: 'BTC',
        side: 'buy',
        priceUsd: dec('0.05'),
        sizeCoin: dec('1'),
        notionalUsd: dec('0.05'),
        feeUsd: dec('0.0001'),
      },
    ]);

    await writer.writePortfolioSnapshot({
      totalNotionalUsd: dec('100'),
      realizedPnlUsd: dec('0'),
      unrealizedPnlUsd: dec('1'),
      feesUsd: dec('0.1'),
      netPnlUsd: dec('0.9'),
      positions: [],
      createdAt: new Date(),
    });

    await writer.close();
  });
});
