import { dec } from '@optarb/core';
import type { OrderAttempt } from '@optarb/execution';
import { describe, expect, it } from 'vitest';
import { InMemoryTradeLog } from './in-memory-trade-log.js';
import { makeFill } from './test-helpers.js';

describe('InMemoryTradeLog', () => {
  it('infers orders from fills when no orders are provided', async () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const log = new InMemoryTradeLog({ fills });
    const orders = await log.getOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.signalId).toBe('s1');
    expect(orders[0]?.signalKind).toBe('cross-venue');
    expect(orders[0]?.venueBuy).toBe('deribit');
    expect(orders[0]?.venueSell).toBe('bybit');
  });

  it('maps OMS order attempts to order records', async () => {
    const attempt: OrderAttempt = {
      id: 'a1',
      signalId: 's1',
      signalKind: 'cross-venue',
      createdAt: 1_000,
      status: 'filled',
      timeoutMs: 5_000,
      legs: [
        {
          venue: 'deribit',
          instrumentId: 'd:opt',
          viewKey: 'k',
          underlying: 'BTC',
          side: 'buy',
          requestedPriceUsd: dec(8_000),
          requestedSizeCoin: dec(1),
          filledSizeCoin: dec(1),
          avgFillPriceUsd: dec(8_000),
          status: 'filled',
          indexPriceUsd: dec(100_000),
          history: [],
        },
        {
          venue: 'bybit',
          instrumentId: 'b:opt',
          viewKey: 'k',
          underlying: 'BTC',
          side: 'sell',
          requestedPriceUsd: dec(8_500),
          requestedSizeCoin: dec(1),
          filledSizeCoin: dec(1),
          avgFillPriceUsd: dec(8_500),
          status: 'filled',
          indexPriceUsd: dec(100_000),
          history: [],
        },
      ],
      fills: [],
      retries: 0,
      firstFillTsMs: 1_000,
      legRiskAlerted: false,
      retryHandled: false,
    };
    const log = new InMemoryTradeLog({ orders: [attempt] });
    const orders = await log.getOrders();
    expect(orders[0]?.status).toBe('executed');
    expect(orders[0]?.requestedNotionalUsd.toNumber()).toBe(16_500);
  });

  it('returns empty arrays by default', async () => {
    const log = new InMemoryTradeLog();
    expect(await log.getFills()).toEqual([]);
    expect(await log.getOrders()).toEqual([]);
    expect(await log.getRiskDecisions()).toEqual([]);
    expect(await log.getPortfolioSnapshots()).toEqual([]);
  });
});
