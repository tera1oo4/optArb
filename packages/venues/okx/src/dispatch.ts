import {
  dec,
  instrumentId,
  L2Book,
  type AppEventMap,
  type AppEventType,
  type Decimal,
  type Instrument,
} from '@optarb/core';
import {
  numOrNull,
  OkxBooks5DataSchema,
  OkxIndexTickerSchema,
  OkxMarkPriceSchema,
  OkxTickerDataSchema,
  OkxTradeSchema,
  OkxWsMessageSchema,
} from './messages.js';
import { parseOkxSymbol } from './symbols.js';

/** An event with type/payload correlated by construction. */
export interface DispatchedEvent {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
}

interface TickerState {
  markPrice: Decimal | null;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  tsMs: number;
}

/**
 * Shared normalization context used identically by the live connector and by
 * replay (ADR-0004): same code path, only the message source differs.
 *
 * OKX public WS splits option data across channels: `tickers` (bid/ask/last
 * only), `mark-price` (markPx per instrument), `index-tickers` (index for the
 * underlying). IV/greeks are not available on public WS (opt-summary is
 * REST-only) → markIv/greeks stay null. Ticker events carry the merged state.
 */
export interface OkxMarketContext {
  instruments: Map<string, Instrument>;
  books: Map<string, L2Book>;
  tickerState: Map<string, TickerState>;
  /** Latest index price per underlying id (e.g. 'BTC-USD'), from index-tickers */
  indexPrices: Map<string, Decimal>;
  bookDepth: number;
  nowMs: () => number;
}

export function createMarketContext(opts?: {
  bookDepth?: number;
  nowMs?: () => number;
}): OkxMarketContext {
  return {
    instruments: new Map(),
    books: new Map(),
    tickerState: new Map(),
    indexPrices: new Map(),
    bookDepth: opts?.bookDepth ?? 5,
    nowMs: opts?.nowMs ?? Date.now,
  };
}

export function ensureInstrument(ctx: OkxMarketContext, instId: string): Instrument {
  let inst = ctx.instruments.get(instId);
  if (!inst) {
    // Fallback for symbols not preloaded via REST.
    const p = parseOkxSymbol(instId);
    inst = {
      id: instrumentId('okx', instId),
      venue: 'okx',
      venueSymbol: instId,
      kind: 'option',
      underlying: p.underlying,
      expiryMs: p.expiryMs,
      strike: p.strike,
      optionType: p.optionType,
      // OKX BTC options: ctVal 1 × ctMult 0.01 = 0.01 coin per contract.
      contractMultiplier: dec('0.01'),
      // Premiums are coin-quoted (bidPx 0.017 = BTC), verified on prod 2026-07-11.
      quoteCurrency: p.underlying,
      settleCurrency: p.underlying,
    };
    ctx.instruments.set(instId, inst);
  }
  return inst;
}

/** Underlying id of an option instId: BTC-USD-260712-63000-C → BTC-USD */
function ulyOf(instId: string): string {
  const parts = instId.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : instId;
}

function stateFor(ctx: OkxMarketContext, instId: string): TickerState {
  let st = ctx.tickerState.get(instId);
  if (!st) {
    st = { markPrice: null, bestBid: null, bestAsk: null, tsMs: 0 };
    ctx.tickerState.set(instId, st);
  }
  return st;
}

function tickerEvent(
  ctx: OkxMarketContext,
  inst: Instrument,
  st: TickerState,
  tsMs: number,
  recvMs: number,
): DispatchedEvent {
  if (tsMs >= st.tsMs) st.tsMs = tsMs;
  return {
    type: 'market.ticker',
    payload: {
      venue: 'okx',
      instrumentId: inst.id,
      tsMs: st.tsMs,
      recvMs,
      markPrice: st.markPrice,
      indexPrice: ctx.indexPrices.get(ulyOf(inst.venueSymbol)) ?? null,
      markIv: null, // not available on OKX public WS (opt-summary is REST-only)
      greeks: null,
      bestBid: st.bestBid,
      bestAsk: st.bestAsk,
      quoteCurrency: inst.quoteCurrency,
    },
  };
}

function handleTicker(data: unknown, ctx: OkxMarketContext, recvMs: number): DispatchedEvent[] {
  const t = OkxTickerDataSchema.parse(data);
  const inst = ensureInstrument(ctx, t.instId);
  const st = stateFor(ctx, t.instId);
  const bid = numOrNull(t.bidPx);
  const ask = numOrNull(t.askPx);
  if (bid !== null) st.bestBid = bid;
  if (ask !== null) st.bestAsk = ask;
  return [tickerEvent(ctx, inst, st, Number(t.ts), recvMs)];
}

function handleMarkPrice(data: unknown, ctx: OkxMarketContext, recvMs: number): DispatchedEvent[] {
  const m = OkxMarkPriceSchema.parse(data);
  const inst = ensureInstrument(ctx, m.instId);
  const st = stateFor(ctx, m.instId);
  st.markPrice = dec(m.markPx);
  return [tickerEvent(ctx, inst, st, Number(m.ts), recvMs)];
}

function handleIndexTicker(data: unknown, ctx: OkxMarketContext): DispatchedEvent[] {
  const idx = OkxIndexTickerSchema.parse(data);
  ctx.indexPrices.set(idx.instId, dec(idx.idxPx));
  return []; // index feeds USD normalization downstream, no event of its own
}

function handleBooks5(
  instId: string,
  data: unknown,
  ctx: OkxMarketContext,
  recvMs: number,
): DispatchedEvent[] {
  const d = OkxBooks5DataSchema.parse(data);
  const inst = ensureInstrument(ctx, instId);
  let book = ctx.books.get(instId);
  if (!book) {
    book = new L2Book();
    ctx.books.set(instId, book);
  }
  // books5 delivers the full top-5 on every push — replace, no gap checks.
  const map = (levels: [string, string, ...string[]][]) =>
    levels.map(([price, size]) => ({ price: dec(price), size: dec(size) }));
  book.replace(map(d.bids), map(d.asks));
  const { bids, asks } = book.top(ctx.bookDepth);
  return [
    {
      type: 'market.book',
      payload: {
        venue: 'okx',
        instrumentId: inst.id,
        tsMs: Number(d.ts),
        recvMs,
        sequence: d.seqId ?? null,
        bids,
        asks,
        quoteCurrency: inst.quoteCurrency,
      },
    },
  ];
}

function handleTrade(data: unknown, ctx: OkxMarketContext, recvMs: number): DispatchedEvent[] {
  const t = OkxTradeSchema.parse(data);
  const inst = ensureInstrument(ctx, t.instId);
  return [
    {
      type: 'market.trade',
      payload: {
        venue: 'okx',
        instrumentId: inst.id,
        tsMs: Number(t.ts),
        recvMs,
        tradeId: t.tradeId,
        price: dec(t.px),
        size: dec(t.sz),
        side: t.side,
        quoteCurrency: inst.quoteCurrency,
      },
    },
  ];
}

/** Routes one OKX ws message; acks/errors yield no events. */
export function handleRawMessage(raw: unknown, ctx: OkxMarketContext): DispatchedEvent[] {
  const msg = OkxWsMessageSchema.safeParse(raw);
  if (!msg.success || !msg.data.arg || !msg.data.data) return [];
  const { channel, instId } = msg.data.arg;
  const recvMs = ctx.nowMs();
  const events: DispatchedEvent[] = [];
  for (const item of msg.data.data) {
    if (channel === 'tickers') events.push(...handleTicker(item, ctx, recvMs));
    else if (channel === 'mark-price') events.push(...handleMarkPrice(item, ctx, recvMs));
    else if (channel === 'index-tickers') events.push(...handleIndexTicker(item, ctx));
    else if (channel === 'books5' && instId)
      events.push(...handleBooks5(instId, item, ctx, recvMs));
    else if (channel === 'trades') events.push(...handleTrade(item, ctx, recvMs));
  }
  return events;
}
