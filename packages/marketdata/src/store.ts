import type {
  BookUpdate,
  Decimal,
  Instrument,
  OptionType,
  QuoteCurrency,
  TickerUpdate,
  Underlying,
  Venue,
} from '@optarb/core';
import { canonicalKeyOf, contractsToCoin, priceToUsd } from './normalize.js';

/** Per-venue quote on one canonical instrument, USD-normalized (read model). */
export interface VenueQuote {
  venue: Venue;
  instrumentId: string;
  bidUsd: Decimal | null;
  askUsd: Decimal | null;
  /** Size at best bid/ask, coin notional */
  bidSizeCoin: Decimal | null;
  askSizeCoin: Decimal | null;
  markUsd: Decimal | null;
  markIv: Decimal | null;
  indexPriceUsd: Decimal | null;
  tsMs: number;
  recvMs: number;
}

/** Consolidated cross-venue view of one canonical option contract. */
export interface InstrumentView {
  key: string;
  underlying: Underlying;
  expiryMs: number;
  strike: Decimal;
  optionType: OptionType;
  quotes: Map<Venue, VenueQuote>;
}

interface MutableQuote {
  venue: Venue;
  instrumentId: string;
  quoteCurrency: QuoteCurrency;
  multiplier: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
  bidSizeContracts: Decimal | null;
  askSizeContracts: Decimal | null;
  mark: Decimal | null;
  markIv: Decimal | null;
  indexPriceUsd: Decimal | null;
  tsMs: number;
  recvMs: number;
}

interface MutableView {
  key: string;
  underlying: Underlying;
  expiryMs: number;
  strike: Decimal;
  optionType: OptionType;
  quotes: Map<Venue, MutableQuote>;
}

/**
 * In-memory consolidated market state across venues (ADR-0004). Fed from the
 * same events in live and replay. Prices are normalized to USD lazily at read
 * time, so book updates arriving before the first index price still converge.
 */
export class MarketDataStore {
  private readonly instruments = new Map<string, Instrument>();
  private readonly viewsByKey = new Map<string, MutableView>();

  /** Registers an instrument (from venue API metadata) and its canonical view. */
  registerInstrument(inst: Instrument): void {
    this.instruments.set(inst.id, inst);
    if (
      inst.kind !== 'option' ||
      inst.expiryMs === null ||
      inst.strike === null ||
      !inst.optionType
    ) {
      return;
    }
    const key = canonicalKeyOf(inst);
    let view = this.viewsByKey.get(key);
    if (!view) {
      view = {
        key,
        underlying: inst.underlying,
        expiryMs: inst.expiryMs,
        strike: inst.strike,
        optionType: inst.optionType,
        quotes: new Map(),
      };
      this.viewsByKey.set(key, view);
    }
    if (!view.quotes.has(inst.venue)) {
      view.quotes.set(inst.venue, {
        venue: inst.venue,
        instrumentId: inst.id,
        quoteCurrency: inst.quoteCurrency,
        multiplier: inst.contractMultiplier,
        bid: null,
        ask: null,
        bidSizeContracts: null,
        askSizeContracts: null,
        mark: null,
        markIv: null,
        indexPriceUsd: null,
        tsMs: 0,
        recvMs: 0,
      });
    }
  }

  applyTicker(t: TickerUpdate): boolean {
    const q = this.quoteFor(t.instrumentId);
    if (!q) return false;
    if (t.bestBid !== null) q.bid = t.bestBid;
    if (t.bestAsk !== null) q.ask = t.bestAsk;
    if (t.markPrice !== null) q.mark = t.markPrice;
    if (t.markIv !== null) q.markIv = t.markIv;
    if (t.indexPrice !== null) q.indexPriceUsd = t.indexPrice;
    if (t.tsMs >= q.tsMs) {
      q.tsMs = t.tsMs;
      q.recvMs = t.recvMs;
    }
    return true;
  }

  applyBook(b: BookUpdate): boolean {
    const q = this.quoteFor(b.instrumentId);
    if (!q) return false;
    const topBid = b.bids[0];
    const topAsk = b.asks[0];
    if (topBid) {
      q.bid = topBid.price;
      q.bidSizeContracts = topBid.size;
    }
    if (topAsk) {
      q.ask = topAsk.price;
      q.askSizeContracts = topAsk.size;
    }
    if (b.tsMs >= q.tsMs) {
      q.tsMs = b.tsMs;
      q.recvMs = b.recvMs;
    }
    return true;
  }

  /** Read-only consolidated snapshot of all instruments with ≥1 quote. */
  views(): InstrumentView[] {
    return [...this.viewsByKey.values()].map((v) => ({
      key: v.key,
      underlying: v.underlying,
      expiryMs: v.expiryMs,
      strike: v.strike,
      optionType: v.optionType,
      quotes: new Map([...v.quotes].map(([venue, q]) => [venue, this.materialize(q)])),
    }));
  }

  getView(key: string): InstrumentView | undefined {
    const v = this.viewsByKey.get(key);
    if (!v) return undefined;
    return {
      key: v.key,
      underlying: v.underlying,
      expiryMs: v.expiryMs,
      strike: v.strike,
      optionType: v.optionType,
      quotes: new Map([...v.quotes].map(([venue, q]) => [venue, this.materialize(q)])),
    };
  }

  private quoteFor(instrumentId: string): MutableQuote | undefined {
    const inst = this.instruments.get(instrumentId);
    if (!inst || inst.kind !== 'option') return undefined;
    const key = canonicalKeyOf(inst);
    return this.viewsByKey.get(key)?.quotes.get(inst.venue);
  }

  private materialize(q: MutableQuote): VenueQuote {
    const bidUsd = q.bid === null ? null : priceToUsd(q.bid, q.quoteCurrency, q.indexPriceUsd);
    const askUsd = q.ask === null ? null : priceToUsd(q.ask, q.quoteCurrency, q.indexPriceUsd);
    const markUsd = q.mark === null ? null : priceToUsd(q.mark, q.quoteCurrency, q.indexPriceUsd);
    return {
      venue: q.venue,
      instrumentId: q.instrumentId,
      bidUsd,
      askUsd,
      bidSizeCoin:
        q.bidSizeContracts === null ? null : contractsToCoin(q.bidSizeContracts, q.multiplier),
      askSizeCoin:
        q.askSizeContracts === null ? null : contractsToCoin(q.askSizeContracts, q.multiplier),
      markUsd,
      markIv: q.markIv,
      indexPriceUsd: q.indexPriceUsd,
      tsMs: q.tsMs,
      recvMs: q.recvMs,
    };
  }
}
