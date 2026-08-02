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
  /** Contract multiplier used to convert sizeCoin to/from contracts. */
  contractMultiplier: Decimal;
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
  /** Top-of-book from the venue's real-time ticker (may carry no sizes). */
  tickerBid: Decimal | null;
  tickerAsk: Decimal | null;
  tickerTsMs: number;
  tickerRecvMs: number;
  /** Top-of-book from the venue's order-book feed (prices + sizes). */
  bookBid: Decimal | null;
  bookAsk: Decimal | null;
  bookBidSizeContracts: Decimal | null;
  bookAskSizeContracts: Decimal | null;
  bookTsMs: number;
  bookRecvMs: number;
  mark: Decimal | null;
  markIv: Decimal | null;
  indexPriceUsd: Decimal | null;
  /** Highest timestamp/recv across all sources; used for freshness checks. */
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
 * Binary (Polymarket) instruments get their own key namespace so their 0–1
 * USDC prices never share a view with vanilla option premiums — the
 * cross-venue detector compares quotes inside one view, and mixing a $0.62
 * digital price with a $1500 premium would produce nonsense signals.
 */
const BINARY_KEY_PREFIX = 'binary:';

export function isBinaryViewKey(key: string): boolean {
  return key.startsWith(BINARY_KEY_PREFIX);
}

function viewKeyOf(inst: Instrument): string {
  const key = canonicalKeyOf(inst);
  return inst.kind === 'binary' ? `${BINARY_KEY_PREFIX}${key}` : key;
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
      (inst.kind !== 'option' && inst.kind !== 'binary') ||
      inst.expiryMs === null ||
      inst.strike === null ||
      !inst.optionType
    ) {
      return;
    }
    const key = viewKeyOf(inst);
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
        tickerBid: null,
        tickerAsk: null,
        tickerTsMs: 0,
        tickerRecvMs: 0,
        bookBid: null,
        bookAsk: null,
        bookBidSizeContracts: null,
        bookAskSizeContracts: null,
        bookTsMs: 0,
        bookRecvMs: 0,
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
    // Drop out-of-order ticks to prevent stale prices with fresh recvMs.
    if (t.tsMs < q.tsMs) return false;
    if (t.bestBid !== null) q.tickerBid = t.bestBid;
    if (t.bestAsk !== null) q.tickerAsk = t.bestAsk;
    if (t.markPrice !== null) q.mark = t.markPrice;
    if (t.markIv !== null) q.markIv = t.markIv;
    if (t.indexPrice !== null) q.indexPriceUsd = t.indexPrice;
    q.tickerTsMs = t.tsMs;
    q.tickerRecvMs = t.recvMs;
    q.tsMs = Math.max(q.tsMs, t.tsMs);
    q.recvMs = Math.max(q.recvMs, t.recvMs);
    return true;
  }

  applyBook(b: BookUpdate): boolean {
    const q = this.quoteFor(b.instrumentId);
    if (!q) return false;
    // Drop out-of-order book updates to prevent stale prices with fresh recvMs.
    if (b.tsMs < q.tsMs) return false;
    const topBid = b.bids[0];
    const topAsk = b.asks[0];
    if (topBid) {
      q.bookBid = topBid.price;
      q.bookBidSizeContracts = topBid.size;
    }
    if (topAsk) {
      q.bookAsk = topAsk.price;
      q.bookAskSizeContracts = topAsk.size;
    }
    q.bookTsMs = b.tsMs;
    q.bookRecvMs = b.recvMs;
    q.tsMs = Math.max(q.tsMs, b.tsMs);
    q.recvMs = Math.max(q.recvMs, b.recvMs);
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
    if (!inst || (inst.kind !== 'option' && inst.kind !== 'binary')) return undefined;
    if (inst.expiryMs === null || inst.strike === null || !inst.optionType) return undefined;
    const key = viewKeyOf(inst);
    return this.viewsByKey.get(key)?.quotes.get(inst.venue);
  }

  private materialize(q: MutableQuote): VenueQuote {
    const bid = this.choosePrice(q.tickerBid, q.tickerRecvMs, q.bookBid, q.bookRecvMs);
    const ask = this.choosePrice(q.tickerAsk, q.tickerRecvMs, q.bookAsk, q.bookRecvMs);

    const bidUsd =
      bid.price === null ? null : priceToUsd(bid.price, q.quoteCurrency, q.indexPriceUsd);
    const askUsd =
      ask.price === null ? null : priceToUsd(ask.price, q.quoteCurrency, q.indexPriceUsd);
    const markUsd = q.mark === null ? null : priceToUsd(q.mark, q.quoteCurrency, q.indexPriceUsd);

    return {
      venue: q.venue,
      instrumentId: q.instrumentId,
      bidUsd,
      askUsd,
      bidSizeCoin:
        bid.fromBook && q.bookBidSizeContracts !== null
          ? contractsToCoin(q.bookBidSizeContracts, q.multiplier)
          : null,
      askSizeCoin:
        ask.fromBook && q.bookAskSizeContracts !== null
          ? contractsToCoin(q.bookAskSizeContracts, q.multiplier)
          : null,
      markUsd,
      markIv: q.markIv,
      indexPriceUsd: q.indexPriceUsd,
      contractMultiplier: q.multiplier,
      tsMs: q.tsMs,
      recvMs: q.recvMs,
    };
  }

  private choosePrice(
    tickerPrice: Decimal | null,
    tickerRecvMs: number,
    bookPrice: Decimal | null,
    bookRecvMs: number,
  ): { price: Decimal | null; fromBook: boolean } {
    const hasTicker = tickerPrice !== null;
    const hasBook = bookPrice !== null;
    if (!hasTicker && !hasBook) return { price: null, fromBook: false };
    if (hasTicker && !hasBook) return { price: tickerPrice, fromBook: false };
    if (!hasTicker && hasBook) return { price: bookPrice, fromBook: true };
    // Both sources present: use the fresher one. Ticker carries no size, so a
    // ticker-overwrite must not retain stale book sizes (review #4).
    return tickerRecvMs > bookRecvMs
      ? { price: tickerPrice, fromBook: false }
      : { price: bookPrice, fromBook: true };
  }
}
