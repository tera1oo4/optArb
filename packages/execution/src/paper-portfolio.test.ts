import { describe, expect, it } from 'vitest';
import { dec, type Side, type Underlying, type Venue } from '@optarb/core';
import { PaperPortfolio } from './paper-portfolio.js';
import type { PaperFill } from './types.js';

function fill(
  venue: Venue,
  instrumentId: string,
  side: Side,
  priceUsd: string,
  sizeCoin: string,
  feeUsd: string,
  tsMs = 1000,
  underlying: Underlying = 'BTC',
): PaperFill {
  return {
    signalId: 's:1',
    tsMs,
    venue,
    instrumentId,
    viewKey: `${underlying}:12345:50000:call`,
    underlying,
    side,
    priceUsd: dec(priceUsd),
    sizeCoin: dec(sizeCoin),
    notionalUsd: dec(priceUsd).mul(sizeCoin),
    feeUsd: dec(feeUsd),
  };
}

function viewFor(instrumentId: string, bidUsd: string | null, askUsd: string | null) {
  return {
    key: 'BTC:12345:50000:call',
    underlying: 'BTC' as Underlying,
    expiryMs: 12345,
    strike: dec('50000'),
    optionType: 'call' as const,
    quotes: new Map([
      [
        'deribit' as Venue,
        {
          venue: 'deribit' as Venue,
          instrumentId,
          bidUsd: bidUsd === null ? null : dec(bidUsd),
          askUsd: askUsd === null ? null : dec(askUsd),
          bidSizeCoin: dec('1'),
          askSizeCoin: dec('1'),
          markUsd: dec('1500'),
          markIv: null,
          indexPriceUsd: dec('100000'),
          tsMs: 1000,
          recvMs: 1000,
        },
      ],
    ]),
  };
}

describe('PaperPortfolio', () => {
  it('tracks a long position and reports unrealized PnL after a price move', () => {
    const pf = new PaperPortfolio();
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'buy', '1000', '2', '50'));

    const snap = pf.snapshot([viewFor('deribit:BTC-OPT', '1200', '1300')]);
    expect(snap.openPositions).toBe(1);
    expect(snap.grossNotionalUsd.toFixed(2)).toBe('2500.00'); // 2 * mid 1250
    expect(snap.unrealizedPnlUsd.toFixed(2)).toBe('500.00'); // 2 * (1250 - 1000)
    expect(snap.feesPaidUsd.toFixed(2)).toBe('50.00');
    expect(snap.netPnlUsd.toFixed(2)).toBe('450.00');
  });

  it('realizes PnL on a partial close', () => {
    const pf = new PaperPortfolio();
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'buy', '1000', '2', '50'));
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'sell', '1200', '1', '30'));

    const snap = pf.snapshot([viewFor('deribit:BTC-OPT', '1200', '1300')]);
    const pos = pf.getPosition('deribit', 'deribit:BTC-OPT')!;
    expect(pos.qty.toString()).toBe('1');
    expect(pos.realizedPnlUsd.toFixed(2)).toBe('200.00'); // 1 * (1200 - 1000)
    expect(snap.realizedPnlUsd.toFixed(2)).toBe('200.00');
    expect(snap.unrealizedPnlUsd.toFixed(2)).toBe('250.00'); // 1 * (1250 - 1000)
    expect(snap.feesPaidUsd.toFixed(2)).toBe('80.00');
    expect(snap.netPnlUsd.toFixed(2)).toBe('370.00');
  });

  it('flips position and resets average entry after full close', () => {
    const pf = new PaperPortfolio();
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'buy', '1000', '1', '10'));
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'sell', '1200', '3', '30'));

    const pos = pf.getPosition('deribit', 'deribit:BTC-OPT')!;
    expect(pos.qty.toString()).toBe('-2');
    expect(pos.realizedPnlUsd.toFixed(2)).toBe('200.00');
    expect(pos.avgEntryUsd.toFixed(2)).toBe('1200.00');
  });

  it('aggregates per-venue and per-underlying exposure', () => {
    const pf = new PaperPortfolio();
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'buy', '1000', '1', '10'));
    pf.applyFill(fill('okx', 'okx:ETH-OPT', 'buy', '50', '10', '5', 1000, 'ETH'));

    const snap = pf.snapshot([
      viewFor('deribit:BTC-OPT', '1100', '1200'),
      {
        key: 'ETH:12345:3000:call',
        underlying: 'ETH',
        expiryMs: 12345,
        strike: dec('3000'),
        optionType: 'call',
        quotes: new Map([
          [
            'okx',
            {
              venue: 'okx',
              instrumentId: 'okx:ETH-OPT',
              bidUsd: dec('55'),
              askUsd: dec('65'),
              bidSizeCoin: dec('1'),
              askSizeCoin: dec('1'),
              markUsd: dec('60'),
              markIv: null,
              indexPriceUsd: dec('3000'),
              tsMs: 1000,
              recvMs: 1000,
            },
          ],
        ]),
      },
    ]);

    expect(snap.perVenue).toHaveLength(2);
    expect(snap.perUnderlying).toHaveLength(2);
    const btc = snap.perUnderlying.find((x) => x.key === 'BTC')!;
    expect(btc.notionalUsd.toFixed(2)).toBe('1150.00'); // 1 * mid 1150
  });

  it('falls back to last fill price when the quote is missing', () => {
    const pf = new PaperPortfolio();
    pf.applyFill(fill('deribit', 'deribit:BTC-OPT', 'buy', '1000', '1', '10'));
    const snap = pf.snapshot([]);
    expect(snap.grossNotionalUsd.toFixed(2)).toBe('1000.00');
    expect(snap.unrealizedPnlUsd.toFixed(2)).toBe('0.00');
  });
});
