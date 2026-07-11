import { describe, expect, it } from 'vitest';
import type { BookUpdate, TickerUpdate, TradeUpdate } from '@optarb/core';
import { createMarketContext, handleRawMessage, type OkxMarketContext } from './dispatch.js';

const INST = 'BTC-USD-260712-56000-C';

function makeCtx(): OkxMarketContext {
  return createMarketContext({ bookDepth: 5, nowMs: () => 42_000 });
}

describe('handleRawMessage — tickers (bid/ask only on public WS)', () => {
  it('normalizes bid/ask and merges the index from index-tickers', () => {
    const ctx = makeCtx();
    // index arrives first
    expect(
      handleRawMessage(
        {
          arg: { channel: 'index-tickers', instId: 'BTC-USD' },
          action: 'snapshot',
          data: [{ instId: 'BTC-USD', idxPx: '64143.7', ts: '1719500000000' }],
        },
        ctx,
      ),
    ).toHaveLength(0);

    const events = handleRawMessage(
      {
        arg: { channel: 'tickers', instId: INST },
        action: 'snapshot',
        data: [
          {
            instId: INST,
            instType: 'OPTION',
            bidPx: '0.017',
            bidSz: '320',
            askPx: '0.02',
            askSz: '1380',
            last: '0.0085',
            ts: '1719500001000',
          },
        ],
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    const t = events[0]!.payload as TickerUpdate;
    expect(t.venue).toBe('okx');
    expect(t.instrumentId).toBe(`okx:${INST}`);
    expect(t.quoteCurrency).toBe('BTC');
    expect(t.bestBid?.toString()).toBe('0.017');
    expect(t.bestAsk?.toString()).toBe('0.02');
    expect(t.indexPrice?.toString()).toBe('64143.7');
    expect(t.markIv).toBeNull();
    expect(t.greeks).toBeNull();
    expect(t.recvMs).toBe(42_000);
  });

  it('merges markPx from the mark-price channel into ticker state', () => {
    const ctx = makeCtx();
    handleRawMessage(
      {
        arg: { channel: 'tickers', instId: INST },
        action: 'snapshot',
        data: [{ instId: INST, bidPx: '0.017', askPx: '0.02', ts: '1000' }],
      },
      ctx,
    );
    const events = handleRawMessage(
      {
        arg: { channel: 'mark-price', instId: INST },
        action: 'snapshot',
        data: [{ instId: INST, markPx: '0.0175567965267362', ts: '1100' }],
      },
      ctx,
    );
    const t = events[0]!.payload as TickerUpdate;
    expect(t.markPrice?.toString()).toBe('0.0175567965267362');
    expect(t.bestBid?.toString()).toBe('0.017'); // merged from the tickers channel
    expect(t.tsMs).toBe(1100);
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
              ['0.017', '2', '0', '1'],
              ['0.016', '5', '0', '2'],
            ],
            asks: [['0.02', '1', '0', '1']],
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
            bids: [['0.018', '3', '0', '1']],
            asks: [['0.019', '1', '0', '1']],
            seqId: 101,
            ts: '1719500000100',
          },
        ],
      },
      ctx,
    );
    const b2 = second[0]!.payload as BookUpdate;
    expect(b2.bids).toHaveLength(1);
    expect(b2.bids[0]!.price.toString()).toBe('0.018');
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
          {
            instId: INST,
            tradeId: '777',
            px: '0.018',
            sz: '4',
            side: 'sell',
            ts: '1719500000000',
          },
        ],
      },
      makeCtx(),
    );
    const t = events[0]!.payload as TradeUpdate;
    expect(events[0]!.type).toBe('market.trade');
    expect(t.side).toBe('sell');
    expect(t.tradeId).toBe('777');
    expect(t.price.toString()).toBe('0.018');
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
