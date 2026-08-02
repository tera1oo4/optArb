import { describe, expect, it } from 'vitest';
import { dec, type Venue } from '@optarb/core';
import type { CrossVenueSignal } from '@optarb/signals';
import { SignalTracker } from './signal-tracker.js';

function signal(
  key: string,
  buyVenue: Venue,
  sellVenue: Venue,
  spreadBps: number,
  tsMs = 0,
): CrossVenueSignal {
  return {
    kind: 'cross-venue',
    key,
    buyVenue,
    buyInstrumentId: `${buyVenue}:${key}`,
    buyPriceUsd: dec('100'),
    sellVenue,
    sellInstrumentId: `${sellVenue}:${key}`,
    sellPriceUsd: dec('102'),
    spreadBps: dec(spreadBps),
    sizeUsd: dec('1000'),
    tsMs,
  };
}

function view(key: string, buyAsk: number, sellBid: number) {
  return {
    key,
    underlying: 'BTC' as const,
    expiryMs: 12345,
    strike: dec('50000'),
    optionType: 'call' as const,
    quotes: new Map([
      [
        'okx' as Venue,
        {
          venue: 'okx' as Venue,
          instrumentId: 'okx:BTC-OPT',
          bidUsd: dec('99'),
          askUsd: dec(buyAsk),
          bidSizeCoin: dec('1'),
          askSizeCoin: dec('1'),
          markUsd: null,
          markIv: null,
          indexPriceUsd: dec('100000'),
          contractMultiplier: dec(1),
          tsMs: 0,
          recvMs: 0,
        },
      ],
      [
        'deribit' as Venue,
        {
          venue: 'deribit' as Venue,
          instrumentId: 'deribit:BTC-OPT',
          bidUsd: dec(sellBid),
          askUsd: dec('103'),
          bidSizeCoin: dec('1'),
          askSizeCoin: dec('1'),
          markUsd: null,
          markIv: null,
          indexPriceUsd: dec('100000'),
          contractMultiplier: dec(1),
          tsMs: 0,
          recvMs: 0,
        },
      ],
    ]),
  };
}

describe('SignalTracker', () => {
  it('records entry spread and emits an outcome at the configured horizon', () => {
    const tracker = new SignalTracker([1000]);
    const s = signal('BTC:12345:50000:call', 'okx', 'deribit', 200, 0);
    tracker.record(s, 0);

    const outcomes = tracker.update([view('BTC:12345:50000:call', 100, 105)], 1000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.entrySpreadBps).toBe('200.00');
    // (105 - 100) / 100 * 10000 = 500
    expect(outcomes[0]!.spreadBps).toBe('500.00');
    expect(outcomes[0]!.horizonMs).toBe(1000);
  });

  it('emits null spread when a required quote disappears', () => {
    const tracker = new SignalTracker([1000]);
    const s = signal('BTC:12345:50000:call', 'okx', 'deribit', 200, 0);
    tracker.record(s, 0);

    const outcomes = tracker.update([], 1000);
    expect(outcomes[0]!.spreadBps).toBeNull();
  });

  it('returns only newly matured horizons', () => {
    const tracker = new SignalTracker([1000, 3000]);
    const s = signal('BTC:12345:50000:call', 'okx', 'deribit', 200, 0);
    tracker.record(s, 0);

    const first = tracker.update([view('BTC:12345:50000:call', 100, 105)], 1500);
    expect(first).toHaveLength(1);
    expect(first[0]!.horizonMs).toBe(1000);

    const second = tracker.update([view('BTC:12345:50000:call', 100, 105)], 3500);
    expect(second).toHaveLength(1);
    expect(second[0]!.horizonMs).toBe(3000);
  });
});
