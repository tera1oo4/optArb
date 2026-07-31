import { describe, expect, it } from 'vitest';
import { dec, instrumentId, type Instrument } from '@optarb/core';
import { canonicalKey, priceToUsd } from './normalize.js';
import { MarketDataStore, isBinaryViewKey } from './store.js';

function makeInst(venue: 'deribit' | 'okx' | 'bybit' | 'binance', symbol: string): Instrument {
  const specs = {
    deribit: { quoteCurrency: 'BTC', multiplier: '1' },
    okx: { quoteCurrency: 'USD', multiplier: '0.01' },
    bybit: { quoteCurrency: 'USDT', multiplier: '1' },
    binance: { quoteCurrency: 'USDT', multiplier: '1' },
  } as const;
  const s = specs[venue];
  return {
    id: instrumentId(venue, symbol),
    venue,
    venueSymbol: symbol,
    kind: 'option',
    underlying: 'BTC',
    expiryMs: Date.UTC(2026, 6, 12, 8, 0, 0, 0),
    strike: dec('63000'),
    optionType: 'call',
    contractMultiplier: dec(s.multiplier),
    quoteCurrency: s.quoteCurrency,
    settleCurrency: s.quoteCurrency,
  };
}

describe('normalize', () => {
  it('builds stable canonical keys', () => {
    expect(
      canonicalKey({
        underlying: 'BTC',
        expiryMs: 1_783_843_200_000,
        strike: dec('63000'),
        optionType: 'call',
      }),
    ).toBe('BTC:1783843200000:63000:call');
  });

  it('converts coin-quoted prices via the index, stables at par', () => {
    expect(priceToUsd(dec('0.02'), 'BTC', dec('64000'))?.toString()).toBe('1280');
    expect(priceToUsd(dec('1280'), 'USDT', null)?.toString()).toBe('1280');
    expect(priceToUsd(dec('0.02'), 'BTC', null)).toBeNull();
  });
});

describe('MarketDataStore', () => {
  it('merges the same contract across venues into one USD-normalized view', () => {
    const store = new MarketDataStore();
    const deribit = makeInst('deribit', 'BTC-12JUL26-63000-C');
    const okx = makeInst('okx', 'BTC-USD-260712-63000-C');
    store.registerInstrument(deribit);
    store.registerInstrument(okx);

    // Deribit: coin-quoted ticker with index
    store.applyTicker({
      venue: 'deribit',
      instrumentId: deribit.id,
      tsMs: 1000,
      recvMs: 1000,
      markPrice: dec('0.02'),
      indexPrice: dec('64000'),
      markIv: dec('0.5'),
      greeks: null,
      bestBid: dec('0.019'),
      bestAsk: dec('0.021'),
      quoteCurrency: 'BTC',
    });
    // OKX: USD-quoted book
    store.applyBook({
      venue: 'okx',
      instrumentId: okx.id,
      tsMs: 1001,
      recvMs: 1001,
      sequence: 5,
      bids: [{ price: dec('1200'), size: dec('100') }],
      asks: [{ price: dec('1350'), size: dec('50') }],
      quoteCurrency: 'USD',
    });

    const views = store.views();
    expect(views).toHaveLength(1);
    const view = views[0]!;
    expect(view.key).toBe('BTC:1783843200000:63000:call');
    expect(view.quotes.size).toBe(2);

    const dq = view.quotes.get('deribit')!;
    expect(dq.bidUsd?.toString()).toBe('1216'); // 0.019 × 64000
    expect(dq.askUsd?.toString()).toBe('1344'); // 0.021 × 64000
    expect(dq.markUsd?.toString()).toBe('1280');

    const oq = view.quotes.get('okx')!;
    expect(oq.bidUsd?.toString()).toBe('1200');
    expect(oq.bidSizeCoin?.toString()).toBe('1'); // 100 contracts × 0.01
    expect(oq.askSizeCoin?.toString()).toBe('0.5');
  });

  it('normalizes book prices once the index arrives (book-before-ticker order)', () => {
    const store = new MarketDataStore();
    const deribit = makeInst('deribit', 'BTC-12JUL26-63000-C');
    store.registerInstrument(deribit);

    store.applyBook({
      venue: 'deribit',
      instrumentId: deribit.id,
      tsMs: 900,
      recvMs: 900,
      sequence: 1,
      bids: [{ price: dec('0.019'), size: dec('3') }],
      asks: [{ price: dec('0.021'), size: dec('2') }],
      quoteCurrency: 'BTC',
    });
    let q = store.getView('BTC:1783843200000:63000:call')!.quotes.get('deribit')!;
    expect(q.bidUsd).toBeNull(); // no index yet

    store.applyTicker({
      venue: 'deribit',
      instrumentId: deribit.id,
      tsMs: 950,
      recvMs: 950,
      markPrice: null,
      indexPrice: dec('64000'),
      markIv: null,
      greeks: null,
      bestBid: null,
      bestAsk: null,
      quoteCurrency: 'BTC',
    });
    q = store.getView('BTC:1783843200000:63000:call')!.quotes.get('deribit')!;
    expect(q.bidUsd?.toString()).toBe('1216');
    expect(q.bidSizeCoin?.toString()).toBe('3');
  });

  it('drops out-of-order updates so stale prices do not overwrite fresh ones', () => {
    const store = new MarketDataStore();
    const inst = makeInst('deribit', 'BTC-12JUL26-63000-C');
    store.registerInstrument(inst);

    store.applyTicker({
      venue: 'deribit',
      instrumentId: inst.id,
      tsMs: 1000,
      recvMs: 1000,
      markPrice: null,
      indexPrice: dec('64000'),
      markIv: null,
      greeks: null,
      bestBid: dec('0.020'),
      bestAsk: dec('0.022'),
      quoteCurrency: 'BTC',
    });

    // Older tick must be ignored.
    store.applyTicker({
      venue: 'deribit',
      instrumentId: inst.id,
      tsMs: 900,
      recvMs: 1100, // recvMs is newer, but tsMs is older
      markPrice: null,
      indexPrice: dec('64000'),
      markIv: null,
      greeks: null,
      bestBid: dec('0.010'),
      bestAsk: dec('0.012'),
      quoteCurrency: 'BTC',
    });

    const q = store.getView('BTC:1783843200000:63000:call')!.quotes.get('deribit')!;
    expect(q.bidUsd?.toString()).toBe('1280'); // 0.020 * 64000
    expect(q.tsMs).toBe(1000);
  });

  it('keeps binary (Polymarket) instruments in a separate key namespace', () => {
    const store = new MarketDataStore();
    const expiryMs = Date.UTC(2026, 6, 12, 16, 0, 0, 0);
    const yes: Instrument = {
      id: instrumentId('polymarket', 'token-yes'),
      venue: 'polymarket',
      venueSymbol: 'token-yes',
      kind: 'binary',
      underlying: 'BTC',
      expiryMs,
      strike: dec('63000'),
      optionType: 'call',
      contractMultiplier: dec(1),
      quoteCurrency: 'USDC',
      settleCurrency: 'USDC',
      metadata: { conditionId: '0xabc', outcome: 'Yes', parseable: 'true' },
    };
    const vanilla = makeInst('deribit', 'BTC-12JUL26-63000-C');
    vanilla.expiryMs = expiryMs;
    store.registerInstrument(yes);
    store.registerInstrument(vanilla);

    store.applyBook({
      venue: 'polymarket',
      instrumentId: yes.id,
      tsMs: 500,
      recvMs: 500,
      sequence: null,
      bids: [{ price: dec('0.61'), size: dec('300') }],
      asks: [{ price: dec('0.63'), size: dec('150') }],
      quoteCurrency: 'USDC',
    });

    const views = store.views();
    expect(views).toHaveLength(2); // binary view does NOT merge with the vanilla view
    const bin = views.find((v) => isBinaryViewKey(v.key))!;
    expect(bin.key).toBe(`binary:BTC:${expiryMs}:63000:call`);
    const pq = bin.quotes.get('polymarket')!;
    expect(pq.bidUsd?.toString()).toBe('0.61'); // USDC at par
    expect(pq.bidSizeCoin?.toString()).toBe('300'); // shares × multiplier 1

    // Unparseable markets (null strike) are registered but get no view.
    const unparseable: Instrument = {
      ...yes,
      id: instrumentId('polymarket', 'token-x'),
      venueSymbol: 'token-x',
      strike: null,
    };
    store.registerInstrument(unparseable);
    expect(store.views()).toHaveLength(2);
  });

  it('ignores events for unregistered instruments', () => {
    const store = new MarketDataStore();
    expect(
      store.applyTicker({
        venue: 'deribit',
        instrumentId: 'deribit:UNKNOWN',
        tsMs: 1,
        recvMs: 1,
        markPrice: null,
        indexPrice: null,
        markIv: null,
        greeks: null,
        bestBid: null,
        bestAsk: null,
        quoteCurrency: 'BTC',
      }),
    ).toBe(false);
    expect(store.views()).toHaveLength(0);
  });
});
