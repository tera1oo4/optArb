import { dec, type Underlying, type Venue } from '@optarb/core';
import type { PaperFill, PortfolioSnapshot } from '@optarb/execution';

export function makeFill(
  signalId: string,
  venue: Venue,
  side: 'buy' | 'sell',
  priceUsd: number,
  sizeCoin: number,
  feeUsd: number,
  underlying: Underlying = 'BTC',
  tsMs = 1_000,
): PaperFill {
  const price = dec(priceUsd);
  const size = dec(sizeCoin);
  return {
    signalId,
    tsMs,
    venue,
    instrumentId: `${venue}:${underlying}-26SEP26-80000-C`,
    viewKey: `BTC-26SEP26-80000-C`,
    underlying,
    side,
    priceUsd: price,
    sizeCoin: size,
    notionalUsd: price.mul(size),
    feeUsd: dec(feeUsd),
  };
}

export function makeSnapshot(
  netPnlUsd: number,
  tsMs: number,
): PortfolioSnapshot & { tsMs: number } {
  return {
    positions: [],
    perVenue: [],
    perUnderlying: [],
    openPositions: 0,
    grossNotionalUsd: dec(0),
    realizedPnlUsd: dec(netPnlUsd),
    unrealizedPnlUsd: dec(0),
    feesPaidUsd: dec(0),
    netPnlUsd: dec(netPnlUsd),
    tsMs,
  };
}
