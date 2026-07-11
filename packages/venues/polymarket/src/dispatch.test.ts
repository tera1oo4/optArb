import { describe, expect, it } from 'vitest';
import {
  dec,
  instrumentId,
  type BookUpdate,
  type Instrument,
  type TickerUpdate,
  type TradeUpdate,
} from '@optarb/core';
import {
  createMarketContext,
  handleRawMessage,
  trackInstrument,
  type PolymarketMarketContext,
} from './dispatch.js';

const YES_TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const NO_TOKEN = '52114319501245915516055106046884209969926127482827954674443846427813813222426';

function yesInstrument(): Instrument {
  return {
    id: instrumentId('polymarket', YES_TOKEN),
    venue: 'polymarket',
    venueSymbol: YES_TOKEN,
    kind: 'binary',
    underlying: 'BTC',
    expiryMs: Date.UTC(2026, 6, 12, 16, 0, 0, 0),
    strike: dec('62000'),
    optionType: 'call',
    contractMultiplier: dec(1),
    quoteCurrency: 'USDC',
    settleCurrency: 'USDC',
    metadata: { conditionId: '0xabc', outcome: 'Yes', parseable: 'true' },
  };
}

function makeCtx(): PolymarketMarketContext {
  const ctx = createMarketContext({ bookDepth: 5, nowMs: () => 42_000 });
  trackInstrument(ctx, yesInstrument());
  return ctx;
}

describe('handleRawMessage — book snapshots', () => {
  it('handles the array-wrapped snapshot the server sends on subscribe', () => {
    const ctx = makeCtx();
    const events = handleRawMessage(
      [
        {
          event_type: 'book',
          asset_id: YES_TOKEN,
          market: '0xbd31dc8a',
          // WS book levels may arrive worst-first; output must be sorted.
          bids: [
            { price: '.48', size: '30' },
            { price: '.50', size: '15' },
            { price: '.49', size: '20' },
          ],
          asks: [
            { price: '.54', size: '10' },
            { price: '.52', size: '25' },
          ],
          timestamp: '1757908892351',
          hash: '0x0',
        },
      ],
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('market.book');
    const b = events[0]!.payload as BookUpdate;
    expect(b.venue).toBe('polymarket');
    expect(b.instrumentId).toBe(`polymarket:${YES_TOKEN}`);
    expect(b.sequence).toBeNull(); // Polymarket has no book sequence
    expect(b.quoteCurrency).toBe('USDC');
    expect(b.tsMs).toBe(1757908892351);
    expect(b.recvMs).toBe(42_000);
    expect(b.bids.map((l) => l.price.toString())).toEqual(['0.5', '0.49', '0.48']);
    expect(b.asks.map((l) => l.price.toString())).toEqual(['0.52', '0.54']);
  });

  it('ignores books for unknown tokens', () => {
    const ctx = makeCtx();
    const events = handleRawMessage(
      { event_type: 'book', asset_id: '999', bids: [], asks: [], timestamp: '1' },
      ctx,
    );
    expect(events).toHaveLength(0);
  });
});

describe('handleRawMessage — price_change deltas', () => {
  it('applies level updates and removals on top of the snapshot', () => {
    const ctx = makeCtx();
    handleRawMessage(
      {
        event_type: 'book',
        asset_id: YES_TOKEN,
        bids: [{ price: '0.50', size: '15' }],
        asks: [{ price: '0.52', size: '25' }],
        timestamp: '1000',
      },
      ctx,
    );

    const events = handleRawMessage(
      {
        event_type: 'price_change',
        market: '0x5f65177b',
        price_changes: [
          {
            asset_id: YES_TOKEN,
            price: '0.51',
            size: '200',
            side: 'BUY',
            hash: 'abc',
            best_bid: '0.51',
            best_ask: '0.52',
          },
          {
            asset_id: YES_TOKEN,
            price: '0.52',
            size: '0', // ask level removed
            side: 'SELL',
            hash: 'def',
            best_bid: '0.51',
            best_ask: '1',
          },
        ],
        timestamp: '1757908892451',
      },
      ctx,
    );
    expect(events).toHaveLength(1); // one book event per touched asset
    const b = events[0]!.payload as BookUpdate;
    expect(b.bids.map((l) => l.price.toString())).toEqual(['0.51', '0.5']);
    expect(b.bids[0]!.size.toString()).toBe('200');
    expect(b.asks).toHaveLength(0); // 0.52 removed, nothing else on the ask side
    expect(b.tsMs).toBe(1757908892451);
  });
});

describe('handleRawMessage — trades and best_bid_ask', () => {
  it('normalizes last_trade_price into a trade with a synthetic id', () => {
    const events = handleRawMessage(
      {
        event_type: 'last_trade_price',
        asset_id: YES_TOKEN,
        market: '0x6a67b9d8',
        price: '0.456',
        side: 'BUY',
        size: '219.217767',
        fee_rate_bps: '0',
        timestamp: '1750428146322',
      },
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('market.trade');
    const t = events[0]!.payload as TradeUpdate;
    expect(t.side).toBe('buy');
    expect(t.price.toString()).toBe('0.456');
    expect(t.size.toString()).toBe('219.217767');
    expect(t.tradeId).toBe(`${YES_TOKEN}:1750428146322:0.456`);
  });

  it('normalizes best_bid_ask into a ticker (no IV/mark on Polymarket)', () => {
    const events = handleRawMessage(
      {
        event_type: 'best_bid_ask',
        asset_id: YES_TOKEN,
        market: '0x0005c0d3',
        best_bid: '0.73',
        best_ask: '0.77',
        spread: '0.04',
        timestamp: '1766789469958',
      },
      makeCtx(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('market.ticker');
    const t = events[0]!.payload as TickerUpdate;
    expect(t.bestBid?.toString()).toBe('0.73');
    expect(t.bestAsk?.toString()).toBe('0.77');
    expect(t.markIv).toBeNull();
    expect(t.markPrice).toBeNull();
  });
});

describe('handleRawMessage — heartbeat and lifecycle events', () => {
  it('ignores {} heartbeat acks and non-market-data events', () => {
    const ctx = makeCtx();
    expect(handleRawMessage({}, ctx)).toHaveLength(0);
    expect(
      handleRawMessage(
        {
          event_type: 'tick_size_change',
          asset_id: YES_TOKEN,
          old_tick_size: '0.01',
          new_tick_size: '0.001',
          timestamp: '100',
        },
        ctx,
      ),
    ).toHaveLength(0);
    expect(
      handleRawMessage(
        { event_type: 'market_resolved', market: '0xabc', winning_outcome: 'Yes' },
        ctx,
      ),
    ).toHaveLength(0);
  });

  it('handles mixed arrays and skips malformed items without throwing', () => {
    const ctx = makeCtx();
    const events = handleRawMessage(
      [
        {},
        { event_type: 'unknown_future_event', foo: 1 },
        {
          event_type: 'book',
          asset_id: YES_TOKEN,
          bids: [{ price: '0.4', size: '5' }],
          asks: [{ price: '0.6', size: '5' }],
          timestamp: '2000',
        },
      ],
      ctx,
    );
    expect(events).toHaveLength(1);
  });
});

describe('context without pre-registered instruments', () => {
  it('silently drops events for tokens it cannot attribute', () => {
    const ctx = createMarketContext({ nowMs: () => 1 });
    expect(
      handleRawMessage({ event_type: 'price_change', price_changes: [], timestamp: '1' }, ctx),
    ).toHaveLength(0);
    expect(NO_TOKEN).toBeDefined();
  });
});
