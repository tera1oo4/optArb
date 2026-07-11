import { dec, type Decimal, type Venue } from '@optarb/core';
import type { InstrumentView, VenueQuote } from '@optarb/marketdata';

export interface CrossVenueSignal {
  kind: 'cross-venue';
  key: string;
  /** Venue where we lift the ask (buy the option) */
  buyVenue: Venue;
  buyInstrumentId: string;
  buyPriceUsd: Decimal;
  /** Venue where we hit the bid (sell the option) */
  sellVenue: Venue;
  sellInstrumentId: string;
  sellPriceUsd: Decimal;
  /** (sell − buy) / buy × 10_000 */
  spreadBps: Decimal;
  /** Executable size in USD: min of both sides' top-of-book size × index */
  sizeUsd: Decimal;
  tsMs: number;
}

export interface CrossVenueDetectorConfig {
  /** Minimum spread to flag, in bps (e.g. '25' = 0.25%) */
  minSpreadBps: Decimal;
  /** Quotes older than this (by recvMs) are ignored */
  maxQuoteAgeMs: number;
  /** Minimum executable size in USD */
  minSizeUsd: Decimal;
}

/**
 * Same-instrument cross-venue arb detector (ADR-0001): flags when the best bid
 * on venue A exceeds the best ask on venue B (A ≠ B) by more than the fee buffer.
 * Stateless — scans consolidated views on demand; works identically live/replay.
 */
export class CrossVenueDetector {
  constructor(private readonly config: CrossVenueDetectorConfig) {}

  detect(views: InstrumentView[], nowMs: number): CrossVenueSignal[] {
    const signals: CrossVenueSignal[] = [];
    for (const view of views) {
      const fresh = [...view.quotes.values()].filter(
        (q) => this.isFresh(q, nowMs) && q.bidUsd !== null && q.askUsd !== null,
      );
      if (fresh.length < 2) continue;

      let bestBid: VenueQuote | null = null;
      let bestAsk: VenueQuote | null = null;
      for (const q of fresh) {
        if (bestBid === null || q.bidUsd!.gt(bestBid.bidUsd!)) bestBid = q;
        if (bestAsk === null || q.askUsd!.lt(bestAsk.askUsd!)) bestAsk = q;
      }
      if (!bestBid || !bestAsk || bestBid.venue === bestAsk.venue) continue;

      const spreadBps = bestBid.bidUsd!.sub(bestAsk.askUsd!).div(bestAsk.askUsd!).mul(10_000);
      if (spreadBps.lt(this.config.minSpreadBps)) continue;

      const sizeUsd = this.executableSizeUsd(bestBid, bestAsk);
      if (sizeUsd === null || sizeUsd.lt(this.config.minSizeUsd)) continue;

      signals.push({
        kind: 'cross-venue',
        key: view.key,
        buyVenue: bestAsk.venue,
        buyInstrumentId: bestAsk.instrumentId,
        buyPriceUsd: bestAsk.askUsd!,
        sellVenue: bestBid.venue,
        sellInstrumentId: bestBid.instrumentId,
        sellPriceUsd: bestBid.bidUsd!,
        spreadBps,
        sizeUsd,
        tsMs: Math.max(bestBid.tsMs, bestAsk.tsMs),
      });
    }
    return signals;
  }

  private isFresh(q: VenueQuote, nowMs: number): boolean {
    return q.recvMs > 0 && nowMs - q.recvMs <= this.config.maxQuoteAgeMs;
  }

  /** min(sell-bid size, buy-ask size) in USD; null when a size is unknown. */
  private executableSizeUsd(bid: VenueQuote, ask: VenueQuote): Decimal | null {
    if (bid.bidSizeCoin === null || ask.askSizeCoin === null) return null;
    if (bid.indexPriceUsd === null || ask.indexPriceUsd === null) return null;
    const sellUsd = bid.bidSizeCoin.mul(bid.indexPriceUsd);
    const buyUsd = ask.askSizeCoin.mul(ask.indexPriceUsd);
    return sellUsd.lte(buyUsd) ? sellUsd : buyUsd;
  }
}

export { dec };
