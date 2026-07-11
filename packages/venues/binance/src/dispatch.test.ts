import { describe, expect, it } from 'vitest';
import type { BookUpdate, TickerUpdate, TradeUpdate } from '@optarb/core';
import {
  applyRestSnapshot,
  createMarketContext,
  handleRawMessage,
  resetBook,
  SequenceGapError,
  type BinanceMarketContext,
} from './dispatch.js';

const SYM = 'BTC-260712-63500-C';

function makeCtx(opts?: Parameters<typeof createMarketContext>[0]): BinanceMarketContext {
  return createMarketContext({ bookDepth: 10, nowMs: () => 42_000, ...opts });
}

function depthMsg(
  U: number,
  u: number,
  pu: number,
  b: [string, string][] = [],
  a: [string, string][] = [],
) {
  return {
    stream: 'btc-260712-63500-c@depth10@100ms',
    data: { e: 'depthUpdate', E: 1_719_500_000_000, T: 1_719_499_999_900, s: SYM, U, u, pu, b, a },
  };
}

describe('handleRawMessage — markPrice', () => {
  it('normalizes mark-price entries into ticker events', () => {
    const events = handleRawMessage(
      {
        stream: 'btcusdt@optionMarkPrice',
        data: [
          {
            e: 'markPrice',
            E: 1_719_500_000_000,
            s: SYM,
            mp: '4124.682',
            i: '64373.54',
            P: '0.000',
            bo: '4060.000',
            ao: '4185.000',
            bq: '3.50',
            aq: '3.02',
            b: '0.28874636',
            a: '0.3159523',
            hl: '7424.428',
            ll: '824.936',
            vo: '0.303',
            rf: '0.0288',
            d: '-0.76453869',
            t: '-35.29269977',
            g: '0.00006801',
            v: '46.02412668',
          },
        ],
      },
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    const t = events[0]!.payload as TickerUpdate;
    expect(events[0]!.type).toBe('market.ticker');
    expect(t.instrumentId).toBe(`binance:${SYM}`);
    expect(t.quoteCurrency).toBe('USDT');
    expect(t.markPrice?.toString()).toBe('4124.682');
    expect(t.indexPrice?.toString()).toBe('64373.54');
    expect(t.markIv?.toString()).toBe('0.303');
    expect(t.bestBid?.toString()).toBe('4060');
    expect(t.greeks?.delta?.toString()).toBe('-0.76453869');
  });
});

describe('handleRawMessage — depth diff chain', () => {
  it('bootstraps on the first diff, then applies chained diffs incl. deletes', () => {
    const requested: string[] = [];
    const ctx = makeCtx({ onRebaseNeeded: (s) => requested.push(s) });
    const e1 = handleRawMessage(depthMsg(10, 12, 7, [['835', '2.6']], [['960', '1']]), ctx);
    const b1 = e1[0]!.payload as BookUpdate;
    expect(b1.bids[0]!.price.toString()).toBe('835');
    expect(b1.sequence).toBe(12);
    expect(requested).toEqual([SYM]); // rebase requested exactly once

    const e2 = handleRawMessage(
      depthMsg(
        13,
        13,
        12,
        [
          ['835', '0'],
          ['830', '1.5'],
        ],
        [],
      ),
      ctx,
    );
    const b2 = e2[0]!.payload as BookUpdate;
    expect(b2.bids[0]!.price.toString()).toBe('830');
    expect(b2.bids).toHaveLength(1);
    expect(requested).toEqual([SYM]);
  });

  it('throws SequenceGapError when pu does not chain', () => {
    const ctx = makeCtx();
    handleRawMessage(depthMsg(10, 12, 7), ctx);
    expect(() => handleRawMessage(depthMsg(20, 21, 19), ctx)).toThrow(SequenceGapError);
  });
});

describe('applyRestSnapshot — rebase', () => {
  it('replaces the book and drops the update-id chain', () => {
    const ctx = makeCtx();
    handleRawMessage(depthMsg(10, 12, 7, [['835', '2.6']], [['960', '1']]), ctx);

    const events = applyRestSnapshot(ctx, SYM, {
      lastUpdateId: 99_999,
      bids: [['900', '5']],
      asks: [['950', '2']],
      T: 1,
    });
    const book = events[0]!.payload as BookUpdate;
    expect(book.bids[0]!.price.toString()).toBe('900');
    expect(book.bids).toHaveLength(1);
    expect(book.sequence).toBe(99_999);

    // Next diff is accepted unconditionally (chain bootstraps again), then chains.
    const e1 = handleRawMessage(depthMsg(100_005, 100_006, 100_004, [['901', '1']], []), ctx);
    expect((e1[0]!.payload as BookUpdate).bids[0]!.price.toString()).toBe('901');
    handleRawMessage(depthMsg(100_007, 100_007, 100_006), ctx);
    expect(() => handleRawMessage(depthMsg(100_010, 100_011, 100_009), ctx)).toThrow(
      SequenceGapError,
    );
  });

  it('resetBook forces a fresh rebase cycle', () => {
    const requested: string[] = [];
    const ctx = makeCtx({ onRebaseNeeded: (s) => requested.push(s) });
    handleRawMessage(depthMsg(10, 12, 7, [['835', '2.6']], []), ctx);
    resetBook(ctx, SYM);
    const events = handleRawMessage(depthMsg(500, 501, 499, [['900', '1']], []), ctx);
    expect((events[0]!.payload as BookUpdate).bids[0]!.price.toString()).toBe('900');
    expect(requested).toEqual([SYM, SYM]);
  });
});

describe('handleRawMessage — trades and acks', () => {
  it('maps taker side from S, falls back to m', () => {
    const ctx = makeCtx();
    const ev1 = handleRawMessage(
      {
        stream: 'btc-260712-63500-c@optionTrade',
        data: {
          e: 'trade',
          E: 1,
          T: 1_719_499_999_900,
          s: SYM,
          t: 55,
          p: '835',
          q: '2.5',
          S: 'SELL',
        },
      },
      ctx,
    );
    const t1 = ev1[0]!.payload as TradeUpdate;
    expect(t1.side).toBe('sell');
    expect(t1.tradeId).toBe('55');
    expect(t1.size.toString()).toBe('2.5');

    const ev2 = handleRawMessage(
      {
        stream: 'btc-260712-63500-c@optionTrade',
        data: { e: 'trade', E: 1, T: 2, s: SYM, t: 56, p: '836', q: '1', m: false },
      },
      ctx,
    );
    expect((ev2[0]!.payload as TradeUpdate).side).toBe('buy');
  });

  it('ignores subscribe acks', () => {
    expect(handleRawMessage({ result: null, id: 1 }, makeCtx())).toHaveLength(0);
  });
});
