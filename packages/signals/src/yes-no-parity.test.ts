import { describe, expect, it } from 'vitest';
import { dec, type OptionType } from '@optarb/core';
import type { InstrumentView, VenueQuote } from '@optarb/marketdata';
import { DEFAULT_FEE_SCHEDULES, type FeeSchedules } from '@optarb/execution';
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
    bidSizeCoin: dec(1_000),
    askSizeCoin: dec(1_000),
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

function makeDetector(
  overrides: { threshold?: string; minSizeUsd?: string; fees?: FeeSchedules } = {},
) {
  return new YesNoParityDetector({
    threshold: dec(overrides.threshold ?? '0.005'),
    maxQuoteAgeMs: 2_000,
    feeSchedules: overrides.fees ?? DEFAULT_FEE_SCHEDULES,
    minSizeUsd: dec(overrides.minSizeUsd ?? '10'),
  });
}

const detector = makeDetector();

describe('YesNoParityDetector', () => {
  it('flags sell-both when YES_bid + NO_bid clears 1 + threshold after fees', () => {
    // sum = 1.05; fees ≈ 0.07×0.62×0.38 + 0.07×0.43×0.57 ≈ 0.0337 → edgeAfterFees ≈ 0.0163
    // raise the raw edge so it still clears the 0.005 buffer after fees.
    const views = [
      binaryView('call', { bidUsd: dec('0.65'), askUsd: dec('0.67') }),
      binaryView('put', { bidUsd: dec('0.45'), askUsd: dec('0.47') }),
    ];
    const signals = detector.detect(views, NOW);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.direction).toBe('sell-both');
    expect(s.marketKey).toBe(PARTS);
    expect(s.yesPrice.toString()).toBe('0.65');
    expect(s.noPrice.toString()).toBe('0.45');
    expect(s.sum.toString()).toBe('1.1');
    expect(s.edge.toString()).toBe('0.1');
    expect(s.edgeAfterFees.lt(s.edge)).toBe(true);
    expect(s.edgeAfterFees.gt(dec('0.005'))).toBe(true);
  });

  it('flags buy-both when YES_ask + NO_ask clears 1 − threshold after fees', () => {
    const views = [
      binaryView('call', { bidUsd: dec('0.50'), askUsd: dec('0.52') }),
      binaryView('put', { bidUsd: dec('0.33'), askUsd: dec('0.35') }),
    ];
    const [s] = detector.detect(views, NOW);
    expect(s!.direction).toBe('buy-both');
    expect(s!.sum.toString()).toBe('0.87');
    expect(s!.edge.toString()).toBe('0.13');
    expect(s!.edgeAfterFees.lt(s!.edge)).toBe(true);
  });

  it('stays silent inside the threshold band (normal market)', () => {
    const views = [
      binaryView('call', { bidUsd: dec('0.60'), askUsd: dec('0.62') }),
      binaryView('put', { bidUsd: dec('0.38'), askUsd: dec('0.40') }),
    ];
    // bids sum 0.98, asks sum 1.02 — both within 2¢ of 1
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('a raw edge that would pass pre-fee is suppressed once fees are deducted', () => {
    // sum = 1.02 → raw edge 0.02, which would have cleared the OLD raw
    // threshold of 0.02, but fees (~0.035 at p≈0.5) exceed it entirely.
    const views = [
      binaryView('call', { bidUsd: dec('0.51'), askUsd: dec('0.53') }),
      binaryView('put', { bidUsd: dec('0.51'), askUsd: dec('0.53') }),
    ];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('a high fee schedule suppresses a signal that would otherwise pass', () => {
    const cheapFees = makeDetector();
    const views = [
      binaryView('call', { bidUsd: dec('0.65'), askUsd: dec('0.67') }),
      binaryView('put', { bidUsd: dec('0.45'), askUsd: dec('0.47') }),
    ];
    expect(cheapFees.detect(views, NOW)).toHaveLength(1);

    const expensiveFees = makeDetector({
      fees: {
        ...DEFAULT_FEE_SCHEDULES,
        polymarket: { kind: 'binary', takerFeeRate: dec('0.5'), makerFeeRate: dec('0') },
      },
    });
    expect(expensiveFees.detect(views, NOW)).toHaveLength(0);
  });

  it('filters out signals below minSizeUsd', () => {
    const views = [
      binaryView('call', {
        bidUsd: dec('0.65'),
        askUsd: dec('0.67'),
        bidSizeCoin: dec('5'),
        askSizeCoin: dec('5'),
      }),
      binaryView('put', {
        bidUsd: dec('0.45'),
        askUsd: dec('0.47'),
        bidSizeCoin: dec('5'),
        askSizeCoin: dec('5'),
      }),
    ];
    // 5 shares × (0.65+0.45) = $5.5, below the default $10 minSizeUsd.
    expect(detector.detect(views, NOW)).toHaveLength(0);
    const lowMin = makeDetector({ minSizeUsd: '1' });
    expect(lowMin.detect(views, NOW)).toHaveLength(1);
  });

  it('requires both tokens of the market', () => {
    const views = [binaryView('call', { bidUsd: dec('0.62'), askUsd: dec('0.64') })];
    expect(detector.detect(views, NOW)).toHaveLength(0);
  });

  it('skips stale quotes', () => {
    const stale = NOW - 10_000;
    const views = [
      binaryView('call', { bidUsd: dec('0.65'), askUsd: dec('0.67'), recvMs: stale }),
      binaryView('put', { bidUsd: dec('0.45'), askUsd: dec('0.47') }),
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
