import { describe, expect, it } from 'vitest';
import type { BookUpdate, TickerUpdate, TradeUpdate } from '@optarb/core';
import { createMarketContext, handleRawMessage, type OkxMarketContext } from './dispatch.js';

const INST = 'BTC-USD-260712-56000-C';

function makeCtx(): OkxMarketContext {
  return createMarketContext({ bookDepth: 5, nowMs: () => 42_000 });
}

describe('handleRawMessage — tickers', () => {
  it('normalizes option ticker with fraction IV', () => {
    const events = handleRawMessage(
      {
        arg: { channel: 'tickers', instId: INST },
        action: 'snapshot',
        data: [
          {
            instId: INST,
            instType: 'OPTION',
            bidPx: '2510.5',
            bidSz: '10',
            askPx: '2522',
            askSz: '5',
            markPx: '2516.2',
            idxPx: '61234.5',
            markVol: '0.4254',
            delta: '-0.2512',
            gamma: '0.00003',
            theta: '-15.2',
            vega: '45.1',
            ts: '1719500000000',
          },
        ],
      },
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    const t = events[0]!.payload as TickerUpdate;
    expect(t.venue).toBe('okx');
    expect(t.instrumentId).toBe(`okx:${INST}`);
    expect(t.quoteCurrency).toBe('USD');
    expect(t.markIv?.toString()).toBe('0.4254');
    expect(t.bestBid?.toString()).toBe('2510.5');
    expect(t.greeks?.vega?.toString()).toBe('45.1');
    expect(t.tsMs).toBe(1_719_500_000_000);
    expect(t.recvMs).toBe(42_000);
  });
});

describe('handleRawMessage — books5', () => {
  it('treats every push as full top-5 replace', () => {
    const ctx = makeCtx();
    const first = handleRawMessage(
      {
        arg: { channel: 'books5', instId: INST },
        action: 'snapshot',
        data: [
          {
            bids: [
              ['2510', '2', '0', '1'],
              ['2509', '5', '0', '2'],
            ],
            asks: [['2520', '1', '0', '1']],
            seqId: 100,
            ts: '1719500000000',
          },
        ],
      },
      ctx,
    );
    const b1 = first[0]!.payload as BookUpdate;
    expect(b1.bids).toHaveLength(2);
    expect(b1.sequence).toBe(100);

    const second = handleRawMessage(
      {
        arg: { channel: 'books5', instId: INST },
        action: 'update',
        data: [
          {
            bids: [['2511', '3', '0', '1']],
            asks: [['2519', '1', '0', '1']],
            seqId: 101,
            ts: '1719500000100',
          },
        ],
      },
      ctx,
    );
    const b2 = second[0]!.payload as BookUpdate;
    // Full replace: old levels gone
    expect(b2.bids).toHaveLength(1);
    expect(b2.bids[0]!.price.toString()).toBe('2511');
    expect(b2.asks[0]!.price.toString()).toBe('2519');
    expect(b2.sequence).toBe(101);
  });
});

describe('handleRawMessage — trades and acks', () => {
  it('normalizes trades', () => {
    const events = handleRawMessage(
      {
        arg: { channel: 'trades', instId: INST },
        action: 'update',
        data: [
          { instId: INST, tradeId: '777', px: '2515', sz: '4', side: 'sell', ts: '1719500000000' },
        ],
      },
      makeCtx(),
    );
    const t = events[0]!.payload as TradeUpdate;
    expect(events[0]!.type).toBe('market.trade');
    expect(t.side).toBe('sell');
    expect(t.tradeId).toBe('777');
    expect(t.price.toString()).toBe('2515');
  });

  it('ignores subscribe acks and errors', () => {
    const ctx = makeCtx();
    expect(
      handleRawMessage(
        { event: 'subscribe', arg: { channel: 'tickers', instId: INST }, connId: 'abc' },
        ctx,
      ),
    ).toHaveLength(0);
    expect(handleRawMessage({ event: 'error', code: '60012', msg: 'bad' }, ctx)).toHaveLength(0);
  });
});
