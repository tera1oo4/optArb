import { describe, expect, it } from 'vitest';
import { dec, type OptionType, type Underlying, type Venue } from '@optarb/core';
import type { InstrumentView, VenueQuote } from '@optarb/marketdata';
import { DigitalVsVanillaDetector } from './digital-vs-vanilla.js';

const NOW = 1_783_000_000_000;
const MS_PER_YEAR = 31_557_600_000;
const EXPIRY = NOW + MS_PER_YEAR / 4; // T = 0.25y

function makeQuote(partial: Partial<VenueQuote>): VenueQuote {
  return {
    venue: 'polymarket',
    instrumentId: 'polymarket:token',
    bidUsd: null,
    askUsd: null,
    bidSizeCoin: null,
    askSizeCoin: null,
    markUsd: null,
    markIv: null,
    indexPriceUsd: null,
    tsMs: NOW - 100,
    recvMs: NOW - 100,
    ...partial,
  };
}

function makeView(opts: {
  key: string;
  optionType?: OptionType;
  quotes: VenueQuote[];
}): InstrumentView {
  return {
    key: opts.key,
    underlying: 'BTC' as Underlying,
    expiryMs: EXPIRY,
    strike: dec('63000'),
    optionType: opts.optionType ?? 'call',
    quotes: new Map(opts.quotes.map((q) => [q.venue, q])),
  };
}

const BINARY_KEY = `binary:BTC:${EXPIRY}:63000:call`;
const VANILLA_KEY = `BTC:${EXPIRY}:63000:call`;

function binaryView(bid: string, ask: string, recvMs = NOW - 100): InstrumentView {
  return makeView({
    key: BINARY_KEY,
    quotes: [
      makeQuote({
        venue: 'polymarket',
        instrumentId: 'polymarket:yes-token',
        bidUsd: dec(bid),
        askUsd: dec(ask),
        recvMs,
      }),
    ],
  });
}

function vanillaView(quote: Partial<VenueQuote>): InstrumentView {
  return makeView({
    key: VANILLA_KEY,
    quotes: [makeQuote({ venue: 'deribit', instrumentId: 'deribit:BTC-C', ...quote })],
  });
}

const detector = new DigitalVsVanillaDetector({
  minDeviation: dec('0.03'),
  rate: dec('0'),
  maxQuoteAgeMs: 2_000,
});

describe('DigitalVsVanillaDetector', () => {
  it('flags a rich YES token vs the Black-76 digital from vanilla IV', () => {
    // F=64000, K=63000, vol=0.5, T=0.25, r=0 → model = N(d2) ≈ 0.475279
    const views = [
      binaryView('0.60', '0.64'),
      vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') }),
    ];
    const signals = detector.detect(views, NOW);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.kind).toBe('digital-vs-vanilla');
    expect(s.key).toBe(BINARY_KEY);
    expect(s.vanillaKey).toBe(VANILLA_KEY);
    expect(s.vanillaVenue).toBe('deribit');
    expect(s.polymarketPrice.toString()).toBe('0.62');
    expect(s.modelPrice.sub(dec('0.4752787991369634')).abs().lt(dec('0.000001'))).toBe(true);
    expect(s.edge.gt(dec('0.14'))).toBe(true); // 0.62 − 0.4753 ≈ 0.1447
  });

  it('flags a cheap YES token (negative edge)', () => {
    const views = [
      binaryView('0.40', '0.44'),
      vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') }),
    ];
    const [s] = detector.detect(views, NOW);
    expect(s!.polymarketPrice.toString()).toBe('0.42');
    expect(s!.edge.lt(dec('-0.03'))).toBe(true);
  });

  it('stays silent inside the deviation band', () => {
    const views = [
      binaryView('0.46', '0.48'),
      vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') }),
    ];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('skips vanilla quotes without IV (OKX public WS has null markIv)', () => {
    const views = [
      binaryView('0.60', '0.64'),
      vanillaView({ markIv: null, indexPriceUsd: dec('64000') }),
    ];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('skips when there is no matching vanilla view', () => {
    expect(detector.detect([binaryView('0.60', '0.64')], NOW)).toHaveLength(0);
  });

  it('skips stale quotes', () => {
    const stale = NOW - 10_000;
    const views = [
      binaryView('0.60', '0.64', stale),
      vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') }),
    ];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('ignores the NO token view (digital put) — parity detector covers it', () => {
    const noView = makeView({
      key: `binary:BTC:${EXPIRY}:63000:put`,
      optionType: 'put',
      quotes: [makeQuote({ bidUsd: dec('0.30'), askUsd: dec('0.34') })],
    });
    const views = [noView, vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') })];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('skips expired contracts (T <= 0)', () => {
    const expired = makeView({
      key: 'binary:BTC:1000:63000:call',
      quotes: [makeQuote({ bidUsd: dec('0.9'), askUsd: dec('0.95') })],
    });
    expired.expiryMs = NOW - 1000;
    const views = [expired, vanillaView({ markIv: dec('0.5'), indexPriceUsd: dec('64000') })];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });
});
