import {
  dec,
  L2Book,
  type AppEventMap,
  type AppEventType,
  type BookUpdate,
  type Instrument,
  type PriceLevel,
  type TickerUpdate,
  type TradeUpdate,
} from '@optarb/core';
import {
  PolyBestBidAskEventSchema,
  PolyBookEventSchema,
  PolyLastTradeEventSchema,
  PolyPriceChangeEventSchema,
  PolyWsEnvelopeSchema,
} from './messages.js';

/** An event with type/payload correlated by construction. */
export interface DispatchedEvent {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
}

/**
 * Shared normalization context used identically by the live connector and by
 * replay (ADR-0004). Keyed by CLOB token id (asset_id): each binary market
 * yields two instruments — the YES token (digital call) and the NO token
 * (digital put), see index.ts for the canonical mapping.
 *
 * Polymarket has no book sequence numbers (`hash` is a dedup marker), so the
 * book is maintained best-effort: snapshot replace + level deltas; a full
 * snapshot is re-sent by the server on every (re)subscribe.
 */
export interface PolymarketMarketContext {
  /** asset_id (token id) → instrument */
  instruments: Map<string, Instrument>;
  /** asset_id → L2 book */
  books: Map<string, L2Book>;
  bookDepth: number;
  nowMs: () => number;
}

export function createMarketContext(opts?: {
  bookDepth?: number;
  nowMs?: () => number;
}): PolymarketMarketContext {
  return {
    instruments: new Map(),
    books: new Map(),
    bookDepth: opts?.bookDepth ?? 10,
    nowMs: opts?.nowMs ?? Date.now,
  };
}

/** Registers an instrument in the context (live connector + tests). */
export function trackInstrument(ctx: PolymarketMarketContext, inst: Instrument): void {
  ctx.instruments.set(inst.venueSymbol, inst);
}

function bookFor(ctx: PolymarketMarketContext, assetId: string): L2Book {
  let book = ctx.books.get(assetId);
  if (!book) {
    book = new L2Book();
    ctx.books.set(assetId, book);
  }
  return book;
}

function toLevels(levels: { price: string; size: string }[]): PriceLevel[] {
  return levels.map((l) => ({ price: dec(l.price), size: dec(l.size) }));
}

function bookEvent(
  ctx: PolymarketMarketContext,
  inst: Instrument,
  tsMs: number,
  recvMs: number,
): DispatchedEvent {
  const book = bookFor(ctx, inst.venueSymbol);
  const { bids, asks } = book.top(ctx.bookDepth);
  const payload: BookUpdate = {
    venue: 'polymarket',
    instrumentId: inst.id,
    tsMs,
    recvMs,
    sequence: null, // Polymarket exposes no book sequence; hash is a dedup marker
    bids,
    asks,
    quoteCurrency: inst.quoteCurrency,
  };
  return { type: 'market.book', payload };
}

function handleBook(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  const ev = PolyBookEventSchema.parse(raw);
  const inst = ctx.instruments.get(ev.asset_id);
  if (!inst) return []; // unknown token — cannot derive canonical metadata from a bare id
  const book = bookFor(ctx, ev.asset_id);
  book.replace(toLevels(ev.bids), toLevels(ev.asks));
  return [bookEvent(ctx, inst, Number(ev.timestamp), ctx.nowMs())];
}

function handlePriceChange(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  const ev = PolyPriceChangeEventSchema.parse(raw);
  const tsMs = Number(ev.timestamp);
  const recvMs = ctx.nowMs();
  const touched = new Map<string, Instrument>();
  for (const change of ev.price_changes) {
    const inst = ctx.instruments.get(change.asset_id);
    if (!inst) continue;
    const book = bookFor(ctx, change.asset_id);
    const level = { price: dec(change.price), size: dec(change.size) };
    // BUY side → bids, SELL side → asks; size 0 deletes the level (L2Book.apply).
    if (change.side === 'BUY') book.apply([level], []);
    else book.apply([], [level]);
    touched.set(change.asset_id, inst);
  }
  return [...touched.values()].map((inst) => bookEvent(ctx, inst, tsMs, recvMs));
}

function handleLastTrade(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  const ev = PolyLastTradeEventSchema.parse(raw);
  const inst = ctx.instruments.get(ev.asset_id);
  if (!inst) return [];
  const payload: TradeUpdate = {
    venue: 'polymarket',
    instrumentId: inst.id,
    tsMs: Number(ev.timestamp),
    recvMs: ctx.nowMs(),
    // CLOB trade prints carry no trade id — synthesize a stable one.
    tradeId: `${ev.asset_id}:${ev.timestamp}:${ev.price}`,
    price: dec(ev.price),
    size: dec(ev.size),
    side: ev.side === 'BUY' ? 'buy' : 'sell',
    quoteCurrency: inst.quoteCurrency,
  };
  return [{ type: 'market.trade', payload }];
}

function handleBestBidAsk(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  const ev = PolyBestBidAskEventSchema.parse(raw);
  const inst = ctx.instruments.get(ev.asset_id);
  if (!inst) return [];
  const payload: TickerUpdate = {
    venue: 'polymarket',
    instrumentId: inst.id,
    tsMs: Number(ev.timestamp),
    recvMs: ctx.nowMs(),
    markPrice: null,
    indexPrice: null,
    markIv: null, // no volatility on Polymarket — IV comes from vanilla venues
    greeks: null,
    bestBid: dec(ev.best_bid),
    bestAsk: dec(ev.best_ask),
    quoteCurrency: inst.quoteCurrency,
  };
  return [{ type: 'market.ticker', payload }];
}

function handleOne(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  const envelope = PolyWsEnvelopeSchema.safeParse(raw);
  if (!envelope.success || !envelope.data.event_type) return []; // `{}` heartbeat ack
  switch (envelope.data.event_type) {
    case 'book':
      return handleBook(raw, ctx);
    case 'price_change':
      return handlePriceChange(raw, ctx);
    case 'last_trade_price':
      return handleLastTrade(raw, ctx);
    case 'best_bid_ask':
      return handleBestBidAsk(raw, ctx);
    default:
      // tick_size_change / new_market / market_resolved — no market-data event in M3.
      return [];
  }
}

/**
 * Routes one CLOB market-channel message. Frames may be a single event object
 * or a JSON array of events (initial book snapshots arrive as an array);
 * `{}` heartbeat acks and lifecycle events yield no events.
 */
export function handleRawMessage(raw: unknown, ctx: PolymarketMarketContext): DispatchedEvent[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => handleOne(item, ctx));
  return handleOne(raw, ctx);
}
