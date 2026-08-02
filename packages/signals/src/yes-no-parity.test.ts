import { describe, expect, it } from 'vitest';
import { dec, type OptionType } from '@optarb/core';
import type { InstrumentView, VenueQuote } from '@optarb/marketdata';
import { YesNoParityDetector } from './yes-no-parity.js';

const NOW = 1_783_000_000_000;
const EXPIRY = NOW + 86_400_000;
const PARTS = `BTC:${EXPIRY}:63000`;

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
    contractMultiplier: dec(1),
    tsMs: NOW - 50,
    recvMs: NOW - 50,
    ...partial,
  };
}

function binaryView(optionType: OptionType, quote: Partial<VenueQuote>): InstrumentView {
  return {
    key: `binary:${PARTS}:${optionType}`,
    underlying: 'BTC',
    expiryMs: EXPIRY,
    strike: dec('63000'),
    optionType,
    quotes: new Map([
      ['polymarket', makeQuote({ instrumentId: `polymarket:${optionType}-token`, ...quote })],
    ]),
  };
}

const detector = new YesNoParityDetector({ threshold: dec('0.02'), maxQuoteAgeMs: 2_000 });

describe('YesNoParityDetector', () => {
  it('flags sell-both when YES_bid + NO_bid > 1 + threshold', () => {
    const views = [
      binaryView('call', { bidUsd: dec('0.62'), askUsd: dec('0.64') }),
      binaryView('put', { bidUsd: dec('0.43'), askUsd: dec('0.45') }),
    ];
    const signals = detector.detect(views, NOW);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.direction).toBe('sell-both');
    expect(s.marketKey).toBe(PARTS);
    expect(s.yesPrice.toString()).toBe('0.62');
    expect(s.noPrice.toString()).toBe('0.43');
    expect(s.sum.toString()).toBe('1.05');
    expect(s.edge.toString()).toBe('0.05');
  });

  it('flags buy-both when YES_ask + NO_ask < 1 − threshold', () => {
    const views = [
      binaryView('call', { bidUsd: dec('0.55'), askUsd: dec('0.57') }),
      binaryView('put', { bidUsd: dec('0.38'), askUsd: dec('0.40') }),
    ];
    const [s] = detector.detect(views, NOW);
    expect(s!.direction).toBe('buy-both');
    expect(s!.sum.toString()).toBe('0.97');
    expect(s!.edge.toString()).toBe('0.03');
  });

  it('stays silent inside the threshold band (normal market)', () => {
    const views = [
      binaryView('call', { bidUsd: dec('0.60'), askUsd: dec('0.62') }),
      binaryView('put', { bidUsd: dec('0.38'), askUsd: dec('0.40') }),
    ];
    // bids sum 0.98, asks sum 1.02 — both within 2¢ of 1
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('requires both tokens of the market', () => {
    const views = [binaryView('call', { bidUsd: dec('0.62'), askUsd: dec('0.64') })];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('skips stale quotes', () => {
    const stale = NOW - 10_000;
    const views = [
      binaryView('call', { bidUsd: dec('0.62'), askUsd: dec('0.64'), recvMs: stale }),
      binaryView('put', { bidUsd: dec('0.43'), askUsd: dec('0.45') }),
    ];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('ignores vanilla views even at the same strike', () => {
    const vanilla: InstrumentView = {
      key: `${PARTS}:call`,
      underlying: 'BTC',
      expiryMs: EXPIRY,
      strike: dec('63000'),
      optionType: 'call',
      quotes: new Map([
        ['deribit', makeQuote({ venue: 'deribit', bidUsd: dec('1200'), askUsd: dec('1300') })],
      ]),
    };
    const views = [vanilla, binaryView('put', { bidUsd: dec('0.43'), askUsd: dec('0.45') })];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });
});
