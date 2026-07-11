import { describe, expect, it } from 'vitest';
import type { BookUpdate, TickerUpdate, TradeUpdate } from '@optarb/core';
import {
  createMarketContext,
  handleRawMessage,
  SequenceGapError,
  type BybitMarketContext,
} from './dispatch.js';

const SYM = 'BTC-25JUN27-45000-P-USDT';

function makeCtx(): BybitMarketContext {
  return createMarketContext({ bookDepth: 50, nowMs: () => 42_000 });
}

describe('handleRawMessage — ticker', () => {
  it('normalizes snapshot ticker with IV as fraction and merges deltas', () => {
    const ctx = makeCtx();
    const snap = handleRawMessage(
      {
        topic: `tickers.${SYM}`,
        type: 'snapshot',
        ts: 1_719_500_000_000,
        data: {
          symbol: SYM,
          bidPrice: '2100.5',
          bidSize: '3',
          askPrice: '2112',
          askSize: '1.5',
          markPrice: '2106.3',
          markPriceIv: '0.4254',
          indexPrice: '61234.5',
          delta: '-0.2512',
          gamma: '0.00003',
          theta: '-15.2',
          vega: '45.1',
        },
      },
      ctx,
    );
    expect(snap).toHaveLength(1);
    const t = snap[0]!.payload as TickerUpdate;
    expect(snap[0]!.type).toBe('market.ticker');
    expect(t.instrumentId).toBe(`bybit:${SYM}`);
    expect(t.quoteCurrency).toBe('USDT');
    expect(t.markIv?.toString()).toBe('0.4254');
    expect(t.bestBid?.toString()).toBe('2100.5');
    expect(t.greeks?.delta?.toString()).toBe('-0.2512');
    expect(t.recvMs).toBe(42_000);

    // Delta carries only changed fields; untouched fields persist from snapshot.
    const delta = handleRawMessage(
      {
        topic: `tickers.${SYM}`,
        type: 'delta',
        ts: 1_719_500_000_100,
        data: { symbol: SYM, bidPrice: '2101', askPrice: '', markPriceIv: '0.43' },
      },
      ctx,
    );
    const d = delta[0]!.payload as TickerUpdate;
    expect(d.bestBid?.toString()).toBe('2101');
    expect(d.bestAsk?.toString()).toBe('2112');
    expect(d.markIv?.toString()).toBe('0.43');
    expect(d.markPrice?.toString()).toBe('2106.3');
  });
});

describe('handleRawMessage — orderbook', () => {
  const topic = `orderbook.50.${SYM}`;

  it('builds book from snapshot then applies deltas incl. deletes', () => {
    const ctx = makeCtx();
    const snap = handleRawMessage(
      {
        topic,
        type: 'snapshot',
        ts: 1,
        data: {
          s: SYM,
          b: [
            ['2100', '2'],
            ['2099', '5'],
          ],
          a: [
            ['2110', '1'],
            ['2111', '3'],
          ],
          u: 100,
          seq: 9,
        },
      },
      ctx,
    );
    const book = snap[0]!.payload as BookUpdate;
    expect(book.bids).toHaveLength(2);
    expect(book.bids[0]!.price.toString()).toBe('2100');
    expect(book.sequence).toBe(100);

    const delta = handleRawMessage(
      {
        topic,
        type: 'delta',
        ts: 2,
        data: {
          s: SYM,
          b: [
            ['2100', '0'],
            ['2102', '1'],
          ],
          a: [['2110', '4']],
          u: 101,
        },
      },
      ctx,
    );
    const upd = delta[0]!.payload as BookUpdate;
    // 2100 deleted, 2102 inserted at top; ask 2110 resized
    expect(upd.bids[0]!.price.toString()).toBe('2102');
    expect(upd.bids[1]!.price.toString()).toBe('2099');
    expect(upd.asks[0]!.size.toString()).toBe('4');
    expect(upd.sequence).toBe(101);
  });

  it('throws SequenceGapError on non-continuous update id', () => {
    const ctx = makeCtx();
    handleRawMessage(
      { topic, type: 'snapshot', ts: 1, data: { s: SYM, b: [], a: [], u: 100 } },
      ctx,
    );
    expect(() =>
      handleRawMessage(
        { topic, type: 'delta', ts: 2, data: { s: SYM, b: [], a: [], u: 105 } },
        ctx,
      ),
    ).toThrow(SequenceGapError);
  });

  it('throws when a delta arrives without a snapshot baseline', () => {
    const ctx = makeCtx();
    expect(() =>
      handleRawMessage({ topic, type: 'delta', ts: 2, data: { s: SYM, b: [], a: [], u: 7 } }, ctx),
    ).toThrow(SequenceGapError);
  });
});

describe('handleRawMessage — trades and acks', () => {
  it('normalizes publicTrade entries', () => {
    const events = handleRawMessage(
      {
        topic: 'publicTrade.BTC',
        type: 'snapshot',
        ts: 1_719_500_000_000,
        data: [
          { i: 't-1', T: 1_719_499_999_900, s: SYM, S: 'Buy', v: '0.5', p: '2105' },
          { i: 't-2', T: 1_719_499_999_950, s: SYM, S: 'Sell', v: '2', p: '2104.5' },
        ],
      },
      makeCtx(),
    );
    expect(events).toHaveLength(2);
    const t0 = events[0]!.payload as TradeUpdate;
    expect(t0.side).toBe('buy');
    expect(t0.tradeId).toBe('t-1');
    expect(t0.size.toString()).toBe('0.5');
    const t1 = events[1]!.payload as TradeUpdate;
    expect(t1.side).toBe('sell');
  });

  it('ignores subscribe acks and pong responses', () => {
    const ctx = makeCtx();
    expect(
      handleRawMessage({ op: 'subscribe', success: true, ret_msg: '', id: '1' }, ctx),
    ).toHaveLength(0);
    expect(handleRawMessage({ op: 'pong', success: true }, ctx)).toHaveLength(0);
    expect(handleRawMessage('not an object', ctx)).toHaveLength(0);
  });
});
