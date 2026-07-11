import {
  dec,
  instrumentId,
  L2Book,
  type AppEventMap,
  type AppEventType,
  type Instrument,
  type PriceLevel,
} from '@optarb/core';
import {
  BinanceWsMessageSchema,
  DepthUpdateSchema,
  MarkPriceDataSchema,
  OptionTradeSchema,
  type RestDepthSchema,
} from './messages.js';
import { parseBinanceSymbol } from './symbols.js';
import type { z } from 'zod';

/** An event with type/payload correlated by construction. */
export interface DispatchedEvent {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
}

export class SequenceGapError extends Error {
  constructor(
    readonly instrument: string,
    readonly detail: string,
  ) {
    super(`binance book gap on ${instrument}: ${detail}`);
    this.name = 'SequenceGapError';
  }
}

type DepthUpdate = z.infer<typeof DepthUpdateSchema>;
export type RestDepth = z.infer<typeof RestDepthSchema>;

interface BookSyncState {
  book: L2Book;
  /** u of the last applied diff; null right after a REST rebase (next diff bootstraps) */
  lastUpdateId: number | null;
  rebaseRequested: boolean;
}

/**
 * Binance option depth is futures-style diff (pu-chained), but the REST depth
 * endpoint lags the WS by many seconds, so strict bracket-chaining against a
 * snapshot is impossible. Instead: REST rebase replaces the whole book and the
 * next diff is accepted unconditionally; afterwards pu must chain. Any gap →
 * the connector rebases again. Diff levels carry absolute sizes, so the book
 * self-heals across rebases.
 */
export interface BinanceMarketContext {
  instruments: Map<string, Instrument>;
  books: Map<string, BookSyncState>;
  /** Live-mode hook: invoked when a REST rebase must be fetched (first diff / after reset). */
  onRebaseNeeded?: (symbol: string) => void;
  bookDepth: number;
  nowMs: () => number;
}

export function createMarketContext(opts?: {
  onRebaseNeeded?: (symbol: string) => void;
  bookDepth?: number;
  nowMs?: () => number;
}): BinanceMarketContext {
  return {
    instruments: new Map(),
    books: new Map(),
    onRebaseNeeded: opts?.onRebaseNeeded,
    bookDepth: opts?.bookDepth ?? 10,
    nowMs: opts?.nowMs ?? Date.now,
  };
}

export function ensureInstrument(ctx: BinanceMarketContext, venueSymbol: string): Instrument {
  let inst = ctx.instruments.get(venueSymbol);
  if (!inst) {
    const p = parseBinanceSymbol(venueSymbol);
    inst = {
      id: instrumentId('binance', venueSymbol),
      venue: 'binance',
      venueSymbol,
      kind: 'option',
      underlying: p.underlying,
      expiryMs: p.expiryMs,
      strike: p.strike,
      optionType: p.optionType,
      // Binance: unit = 1 (exchangeInfo), USDT-quoted and USDT-settled.
      contractMultiplier: dec(1),
      quoteCurrency: 'USDT',
      settleCurrency: 'USDT',
    };
    ctx.instruments.set(venueSymbol, inst);
  }
  return inst;
}

function bookEvent(
  inst: Instrument,
  book: L2Book,
  depth: number,
  sequence: number,
  tsMs: number,
  recvMs: number,
): DispatchedEvent {
  const { bids, asks } = book.top(depth);
  return {
    type: 'market.book',
    payload: {
      venue: 'binance',
      instrumentId: inst.id,
      tsMs,
      recvMs,
      sequence,
      bids,
      asks,
      quoteCurrency: inst.quoteCurrency,
    },
  };
}

function getState(ctx: BinanceMarketContext, symbol: string): BookSyncState {
  let st = ctx.books.get(symbol);
  if (!st) {
    st = { book: new L2Book(), lastUpdateId: null, rebaseRequested: false };
    ctx.books.set(symbol, st);
  }
  return st;
}

const mapLevels = (levels: [string, string][]): PriceLevel[] =>
  levels.map(([price, size]) => ({ price: dec(price), size: dec(size) }));

function applyDiff(st: BookSyncState, d: DepthUpdate): void {
  // After a rebase (lastUpdateId === null) the next diff is accepted unconditionally.
  if (st.lastUpdateId !== null && d.pu !== st.lastUpdateId) {
    throw new SequenceGapError(d.s, `pu=${d.pu} but last u=${st.lastUpdateId}`);
  }
  st.book.apply(mapLevels(d.b), mapLevels(d.a));
  st.lastUpdateId = d.u;
}

function handleDepth(ctx: BinanceMarketContext, d: DepthUpdate, recvMs: number): DispatchedEvent[] {
  const inst = ensureInstrument(ctx, d.s);
  const st = getState(ctx, d.s);
  if (st.lastUpdateId === null && !st.rebaseRequested) {
    // First diff ever for this symbol → ask the connector for a REST rebase.
    st.rebaseRequested = true;
    ctx.onRebaseNeeded?.(d.s);
  }
  applyDiff(st, d);
  return [bookEvent(inst, st.book, ctx.bookDepth, d.u, d.T, recvMs)];
}

/**
 * Called by the live connector when a REST depth snapshot arrives: replaces the
 * book and drops the update-id chain — the next diff bootstraps a fresh chain.
 */
export function applyRestSnapshot(
  ctx: BinanceMarketContext,
  symbol: string,
  snapshot: RestDepth,
): DispatchedEvent[] {
  const recvMs = ctx.nowMs();
  const inst = ensureInstrument(ctx, symbol);
  const st = getState(ctx, symbol);
  st.book.replace(mapLevels(snapshot.bids), mapLevels(snapshot.asks));
  st.lastUpdateId = null;
  st.rebaseRequested = false;
  return [bookEvent(inst, st.book, ctx.bookDepth, snapshot.lastUpdateId, recvMs, recvMs)];
}

export function resetBook(ctx: BinanceMarketContext, symbol: string): void {
  ctx.books.delete(symbol);
}

function handleMarkPrice(
  ctx: BinanceMarketContext,
  raw: unknown,
  recvMs: number,
): DispatchedEvent[] {
  return MarkPriceDataSchema.parse(raw).map((e) => {
    const inst = ensureInstrument(ctx, e.s);
    return {
      type: 'market.ticker' as const,
      payload: {
        venue: 'binance' as const,
        instrumentId: inst.id,
        tsMs: e.E,
        recvMs,
        markPrice: dec(e.mp),
        indexPrice: dec(e.i),
        // Binance IVs are fractions already (0.303 = 30.3%)
        markIv: dec(e.vo),
        greeks: {
          delta: e.d !== undefined ? dec(e.d) : undefined,
          gamma: e.g !== undefined ? dec(e.g) : undefined,
          vega: e.v !== undefined ? dec(e.v) : undefined,
          theta: e.t !== undefined ? dec(e.t) : undefined,
        },
        bestBid: dec(e.bo),
        bestAsk: dec(e.ao),
        quoteCurrency: inst.quoteCurrency,
      },
    };
  });
}

function handleTrade(ctx: BinanceMarketContext, raw: unknown, recvMs: number): DispatchedEvent[] {
  const t = OptionTradeSchema.parse(raw);
  const inst = ensureInstrument(ctx, t.s);
  const side =
    t.S === 'BUY'
      ? 'buy'
      : t.S === 'SELL'
        ? 'sell'
        : t.m === undefined
          ? 'buy'
          : t.m
            ? 'sell'
            : 'buy';
  return [
    {
      type: 'market.trade',
      payload: {
        venue: 'binance',
        instrumentId: inst.id,
        tsMs: t.T,
        recvMs,
        tradeId: String(t.t),
        price: dec(t.p),
        size: dec(t.q),
        side,
        quoteCurrency: inst.quoteCurrency,
      },
    },
  ];
}

/** Routes one combined-stream message; acks yield no events. */
export function handleRawMessage(raw: unknown, ctx: BinanceMarketContext): DispatchedEvent[] {
  const msg = BinanceWsMessageSchema.safeParse(raw);
  if (!msg.success || !msg.data.stream || msg.data.data === undefined) return [];
  const { stream, data } = msg.data;
  const recvMs = ctx.nowMs();

  if (stream.endsWith('@optionMarkPrice')) return handleMarkPrice(ctx, data, recvMs);
  if (stream.includes('@depth')) return handleDepth(ctx, DepthUpdateSchema.parse(data), recvMs);
  if (stream.endsWith('@optionTrade')) return handleTrade(ctx, data, recvMs);
  return [];
}
