import { describe, expect, it } from 'vitest';
import { SequenceGapError } from './book-builder.js';
import {
  createMarketContext,
  handleChannelMessage,
  handleRawMessage,
  type DeribitMarketContext,
} from './dispatch.js';

function makeCtx(): DeribitMarketContext {
  return createMarketContext({ bookDepth: 10, nowMs: () => 42_000 });
}

describe('handleChannelMessage — ticker', () => {
  it('normalizes option ticker incl. IV percent → fraction', () => {
    const events = handleChannelMessage(
      'ticker.BTC-28JUN24-70000-C.100ms',
      {
        instrument_name: 'BTC-28JUN24-70000-C',
        timestamp: 1_719_500_000_000,
        best_bid_price: 0.0125,
        best_ask_price: 0.013,
        mark_price: 0.0127,
        index_price: 61_500.5,
        mark_iv: 55.25,
        greeks: { delta: 0.31, gamma: 0.00002, vega: 12.5, theta: -5.1, rho: 1.2 },
      },
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('market.ticker');
    const t = ev.payload as import('@optarb/core').TickerUpdate;
    expect(t.instrumentId).toBe('deribit:BTC-28JUN24-70000-C');
    expect(t.quoteCurrency).toBe('BTC');
    expect(t.markIv?.toString()).toBe('0.5525');
    expect(t.greeks?.delta?.toString()).toBe('0.31');
    expect(t.recvMs).toBe(42_000);
  });
});

describe('handleChannelMessage — book', () => {
  it('builds book from snapshot then change', () => {
    const ctx = makeCtx();
    const channel = 'book.BTC-28JUN24-70000-C.none.10.100ms';
    const snap = handleChannelMessage(
      channel,
      {
        type: 'snapshot',
        timestamp: 1,
        instrument_name: 'BTC-28JUN24-70000-C',
        change_id: 500,
        bids: [['new', 0.012, 5]],
        asks: [['new', 0.014, 2]],
      },
      ctx,
    );
    const book = snap[0]!.payload as import('@optarb/core').BookUpdate;
    expect(book.bids[0]!.price.toString()).toBe('0.012');
    expect(book.sequence).toBe(500);

    const upd = handleChannelMessage(
      channel,
      {
        type: 'change',
        timestamp: 2,
        instrument_name: 'BTC-28JUN24-70000-C',
        change_id: 501,
        prev_change_id: 500,
        bids: [['change', 0.012, 7]],
        asks: [],
      },
      ctx,
    );
    const book2 = upd[0]!.payload as import('@optarb/core').BookUpdate;
    expect(book2.bids[0]!.size.toNumber()).toBe(7);
  });

  it('accepts interval-channel snapshots without type/prev_change_id (real wire format)', () => {
    const events = handleChannelMessage(
      'book.BTC-12JUL26-57000-C.none.10.100ms',
      {
        timestamp: 1_783_774_643_287,
        instrument_name: 'BTC-12JUL26-57000-C',
        change_id: 107_180_377_135,
        bids: [[0.0795, 10]],
        asks: [[0.1415, 10]],
      },
      makeCtx(),
    );
    const book = events[0]!.payload as import('@optarb/core').BookUpdate;
    expect(book.bids[0]!.price.toString()).toBe('0.0795');
    expect(book.asks[0]!.size.toNumber()).toBe(10);
    expect(book.sequence).toBe(107_180_377_135);
  });

  it('propagates SequenceGapError for the caller to resync', () => {
    const ctx = makeCtx();
    const channel = 'book.BTC-28JUN24-70000-C.none.10.100ms';
    handleChannelMessage(
      channel,
      {
        type: 'snapshot',
        timestamp: 1,
        instrument_name: 'BTC-28JUN24-70000-C',
        change_id: 500,
        bids: [],
        asks: [],
      },
      ctx,
    );
    expect(() =>
      handleChannelMessage(
        channel,
        {
          type: 'change',
          timestamp: 2,
          instrument_name: 'BTC-28JUN24-70000-C',
          change_id: 510,
          prev_change_id: 509,
          bids: [],
          asks: [],
        },
        ctx,
      ),
    ).toThrow(SequenceGapError);
  });
});

describe('handleChannelMessage — trades', () => {
  it('normalizes trade arrays', () => {
    const events = handleChannelMessage(
      'trades.BTC-28JUN24-70000-C.100ms',
      [
        {
          trade_id: 'ETH-12345',
          instrument_name: 'BTC-28JUN24-70000-C',
          price: 0.0128,
          amount: 10,
          direction: 'buy',
          timestamp: 1_719_500_000_500,
        },
      ],
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    const tr = events[0]!.payload as import('@optarb/core').TradeUpdate;
    expect(tr.side).toBe('buy');
    expect(tr.size.toNumber()).toBe(10);
    expect(tr.quoteCurrency).toBe('BTC');
  });

  it('ignores unknown channels', () => {
    expect(handleChannelMessage('user.orders.BTC.raw', {}, makeCtx())).toEqual([]);
  });
});

describe('handleRawMessage', () => {
  it('routes subscription envelopes and ignores the rest', () => {
    const ctx = makeCtx();
    expect(
      handleRawMessage(
        { jsonrpc: '2.0', method: 'heartbeat', params: { type: 'test_request' } },
        ctx,
      ),
    ).toEqual([]);
    expect(handleRawMessage({ jsonrpc: '2.0', id: 1, result: [] }, ctx)).toEqual([]);

    const events = handleRawMessage(
      {
        jsonrpc: '2.0',
        method: 'subscription',
        params: {
          channel: 'trades.BTC-PERPETUAL.100ms',
          data: [
            {
              trade_id: '1',
              instrument_name: 'BTC-PERPETUAL',
              price: 61_000,
              amount: 100,
              direction: 'sell',
              timestamp: 1,
            },
          ],
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('market.trade');
  });
});
