import { describe, expect, it } from 'vitest';
import { dec, instrumentId, type Instrument } from '@optarb/core';
import { MarketDataStore } from '@optarb/marketdata';
import { CrossVenueDetector } from './cross-venue.js';

const EXPIRY = Date.UTC(2026, 6, 12, 8, 0, 0, 0);
const KEY = `BTC:${EXPIRY}:63000:call`;

function inst(venue: 'deribit' | 'okx' | 'binance', symbol: string): Instrument {
  return {
    id: instrumentId(venue, symbol),
    venue,
    venueSymbol: symbol,
    kind: 'option',
    underlying: 'BTC',
    expiryMs: EXPIRY,
    strike: dec('63000'),
    optionType: 'call',
    contractMultiplier: dec(venue === 'okx' ? '0.01' : '1'),
    // binance is USDT-quoted; deribit/okx quote premiums in coin
    quoteCurrency: venue === 'binance' ? 'USD' : 'BTC',
    settleCurrency: venue === 'binance' ? 'USD' : 'BTC',
  };
}

function feedBook(
  store: MarketDataStore,
  i: Instrument,
  bid: string,
  bidSz: string,
  ask: string,
  askSz: string,
  recvMs: number,
  index = '64000',
) {
  // index via ticker first (needed for deribit coin-quoted conversion)
  store.applyTicker({
    venue: i.venue,
    instrumentId: i.id,
    tsMs: recvMs,
    recvMs,
    markPrice: null,
    indexPrice: dec(index),
    markIv: null,
    greeks: null,
    bestBid: null,
    bestAsk: null,
    quoteCurrency: i.quoteCurrency,
  });
  store.applyBook({
    venue: i.venue,
    instrumentId: i.id,
    tsMs: recvMs,
    recvMs,
    sequence: 1,
    bids: [{ price: dec(bid), size: dec(bidSz) }],
    asks: [{ price: dec(ask), size: dec(askSz) }],
    quoteCurrency: i.quoteCurrency,
  });
}

function makeDetector() {
  return new CrossVenueDetector({
    minSpreadBps: dec('25'),
    maxQuoteAgeMs: 2_000,
    minSizeUsd: dec('1000'),
  });
}

describe('CrossVenueDetector', () => {
  it('flags a cross-venue dislocation with correct direction and size', () => {
    const store = new MarketDataStore();
    const d = inst('deribit', 'BTC-12JUL26-63000-C');
    const o = inst('okx', 'BTC-USD-260712-63000-C');
    store.registerInstrument(d);
    store.registerInstrument(o);
    // Deribit rich (bid 0.02 BTC = $1280), OKX cheap (ask $1250) → buy OKX, sell Deribit
    feedBook(store, d, '0.02', '2', '0.0205', '2', 10_000);
    feedBook(store, o, '0.01875', '100', '0.01953125', '300', 10_000); // $1200/$1250 at 64k

    const signals = makeDetector().detect(store.views(), 10_500);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.key).toBe(KEY);
    expect(s.buyVenue).toBe('okx');
    expect(s.sellVenue).toBe('deribit');
    expect(s.buyPriceUsd.toString()).toBe('1250');
    expect(s.sellPriceUsd.toString()).toBe('1280');
    // (1280-1250)/1250 = 2.4% = 240 bps
    expect(s.spreadBps.toString()).toBe('240');
    // sell size 2 coin × 64000 = 128000; buy size 300 × 0.01 = 3 coin × 64000 = 192000 → min
    expect(s.sizeUsd.toString()).toBe('128000');
  });

  it('ignores stale quotes', () => {
    const store = new MarketDataStore();
    const d = inst('deribit', 'BTC-12JUL26-63000-C');
    const o = inst('okx', 'BTC-USD-260712-63000-C');
    store.registerInstrument(d);
    store.registerInstrument(o);
    feedBook(store, d, '0.02', '2', '0.0205', '2', 10_000);
    feedBook(store, o, '0.01875', '100', '0.01953125', '300', 10_000); // $1200/$1250 at 64k
    // 3s later → beyond maxQuoteAgeMs
    expect(makeDetector().detect(store.views(), 13_001)).toHaveLength(0);
  });

  it('does not flag when the best market is on one venue', () => {
    const store = new MarketDataStore();
    const d = inst('deribit', 'BTC-12JUL26-63000-C');
    const o = inst('okx', 'BTC-USD-260712-63000-C');
    store.registerInstrument(d);
    store.registerInstrument(o);
    // OKX strictly inside Deribit's market → no arb
    feedBook(store, d, '0.019', '2', '0.021', '2', 10_000); // 1216 / 1344
    feedBook(store, o, '0.0190625', '100', '0.0209375', '300', 10_000); // $1220/$1340 at 64k
    expect(makeDetector().detect(store.views(), 10_500)).toHaveLength(0);
  });

  it('enforces the minimum executable size', () => {
    const store = new MarketDataStore();
    const d = inst('deribit', 'BTC-12JUL26-63000-C');
    const o = inst('okx', 'BTC-USD-260712-63000-C');
    store.registerInstrument(d);
    store.registerInstrument(o);
    // Dislocation exists but sizes are tiny (0.01 coin = $640 < minSizeUsd 1000)
    feedBook(store, d, '0.02', '0.01', '0.0205', '0.01', 10_000);
    feedBook(store, o, '1200', '1', '1250', '1', 10_000);
    expect(makeDetector().detect(store.views(), 10_500)).toHaveLength(0);
  });

  it('enforces the spread threshold', () => {
    const store = new MarketDataStore();
    const d = inst('deribit', 'BTC-12JUL26-63000-C');
    const b = inst('binance', 'BTC-260712-63000-C');
    store.registerInstrument(d);
    store.registerInstrument(b);
    // 10 bps dislocation < 25 bps threshold
    feedBook(store, d, '0.02', '2', '0.0201', '2', 10_000); // bid $1280
    feedBook(store, b, '1278', '2', '1278.8', '2', 10_000); // ask $1278.8 → ~9.4bps
    expect(makeDetector().detect(store.views(), 10_500)).toHaveLength(0);
  });
});
