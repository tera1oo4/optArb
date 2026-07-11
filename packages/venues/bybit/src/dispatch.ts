import {
  dec,
  instrumentId,
  L2Book,
  type AppEventMap,
  type AppEventType,
  type Decimal,
  type Instrument,
  type QuoteCurrency,
} from '@optarb/core';
import {
  BybitOrderbookDataSchema,
  BybitTickerDataSchema,
  BybitTradesDataSchema,
  BybitWsMessageSchema,
  numOrNull,
} from './messages.js';
import { parseBybitSymbol } from './symbols.js';

/** An event with type/payload correlated by construction. */
export interface DispatchedEvent {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
}

export class SequenceGapError extends Error {
  constructor(
    readonly instrument: string,
    readonly expected: number,
    readonly got: number,
  ) {
    super(`bybit book sequence gap on ${instrument}: expected u=${expected}, got u=${got}`);
    this.name = 'SequenceGapError';
  }
}

/** Last-known ticker fields; Bybit sends partial deltas after the snapshot. */
interface TickerState {
  markPrice: Decimal | null;
  indexPrice: Decimal | null;
  markIv: Decimal | null;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  delta: Decimal | null;
  gamma: Decimal | null;
  theta: Decimal | null;
  vega: Decimal | null;
}

/**
 * Shared normalization context used identically by the live connector and by
 * replay (ADR-0004): same code path, only the message source differs.
 */
export interface BybitMarketContext {
  instruments: Map<string, Instrument>;
  books: Map<string, L2Book>;
  /** Per-symbol last orderbook update id `u` (delta sequencing) */
  bookSeq: Map<string, number>;
  tickerState: Map<string, TickerState>;
  bookDepth: number;
  nowMs: () => number;
}

export function createMarketContext(opts?: {
  bookDepth?: number;
  nowMs?: () => number;
}): BybitMarketContext {
  return {
    instruments: new Map(),
    books: new Map(),
    bookSeq: new Map(),
    tickerState: new Map(),
    bookDepth: opts?.bookDepth ?? 50,
    nowMs: opts?.nowMs ?? Date.now,
  };
}

export function ensureInstrument(ctx: BybitMarketContext, venueSymbol: string): Instrument {
  let inst = ctx.instruments.get(venueSymbol);
  if (!inst) {
    // Fallback for symbols not preloaded via REST; specs still parsed from the symbol.
    const p = parseBybitSymbol(venueSymbol);
    const settle: QuoteCurrency = p.settleSuffix ?? 'USDT';
    inst = {
      id: instrumentId('bybit', venueSymbol),
      venue: 'bybit',
      venueSymbol,
      kind: 'option',
      underlying: p.underlying,
      expiryMs: p.expiryMs,
      strike: p.strike,
      optionType: p.optionType,
      // Empirical (2026-07-11): 1 Bybit USDT option ≈ 1 coin; not exposed by the API.
      contractMultiplier: dec(1),
      quoteCurrency: settle,
      settleCurrency: settle,
    };
    ctx.instruments.set(venueSymbol, inst);
  }
  return inst;
}

function handleTicker(
  data: unknown,
  tsMs: number | undefined,
  ctx: BybitMarketContext,
  recvMs: number,
): DispatchedEvent[] {
  const t = BybitTickerDataSchema.parse(data);
  const inst = ensureInstrument(ctx, t.symbol);
  let st = ctx.tickerState.get(t.symbol);
  if (!st) {
    st = {
      markPrice: null,
      indexPrice: null,
      markIv: null,
      bestBid: null,
      bestAsk: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
    };
    ctx.tickerState.set(t.symbol, st);
  }
  // Merge: delta messages only carry changed fields; empty string = absent.
  const merge = (field: keyof TickerState, raw: string | undefined) => {
    const v = numOrNull(raw);
    if (v !== null) st[field] = v;
  };
  merge('markPrice', t.markPrice);
  merge('indexPrice', t.indexPrice);
  merge('markIv', t.markPriceIv);
  merge('bestBid', t.bidPrice);
  merge('bestAsk', t.askPrice);
  merge('delta', t.delta);
  merge('gamma', t.gamma);
  merge('theta', t.theta);
  merge('vega', t.vega);

  const greeks =
    st.delta || st.gamma || st.theta || st.vega
      ? {
          delta: st.delta ?? undefined,
          gamma: st.gamma ?? undefined,
          theta: st.theta ?? undefined,
          vega: st.vega ?? undefined,
        }
      : null;

  return [
    {
      type: 'market.ticker',
      payload: {
        venue: 'bybit',
        instrumentId: inst.id,
        tsMs: tsMs ?? recvMs,
        recvMs,
        markPrice: st.markPrice,
        indexPrice: st.indexPrice,
        markIv: st.markIv,
        greeks,
        bestBid: st.bestBid,
        bestAsk: st.bestAsk,
        quoteCurrency: inst.quoteCurrency,
      },
    },
  ];
}

function handleOrderbook(
  type: 'snapshot' | 'delta',
  data: unknown,
  tsMs: number | undefined,
  ctx: BybitMarketContext,
  recvMs: number,
): DispatchedEvent[] {
  const d = BybitOrderbookDataSchema.parse(data);
  const inst = ensureInstrument(ctx, d.s);
  let book = ctx.books.get(d.s);
  if (!book) {
    book = new L2Book();
    ctx.books.set(d.s, book);
  }

  const mapLevels = (levels: [string, string][]) =>
    levels.map(([price, size]) => ({ price: dec(price), size: dec(size) }));

  if (type === 'snapshot') {
    book.replace(mapLevels(d.b), mapLevels(d.a));
    ctx.bookSeq.set(d.s, d.u);
  } else {
    const prev = ctx.bookSeq.get(d.s);
    // Without a baseline a delta is meaningless; with one, u must be continuous.
    if (prev === undefined || d.u !== prev + 1) {
      throw new SequenceGapError(d.s, prev === undefined ? -1 : prev + 1, d.u);
    }
    book.apply(mapLevels(d.b), mapLevels(d.a));
    ctx.bookSeq.set(d.s, d.u);
  }

  const { bids, asks } = book.top(ctx.bookDepth);
  return [
    {
      type: 'market.book',
      payload: {
        venue: 'bybit',
        instrumentId: inst.id,
        tsMs: tsMs ?? recvMs,
        recvMs,
        sequence: d.u,
        bids,
        asks,
        quoteCurrency: inst.quoteCurrency,
      },
    },
  ];
}

function handleTrades(data: unknown, ctx: BybitMarketContext, recvMs: number): DispatchedEvent[] {
  return BybitTradesDataSchema.parse(data).map((t) => {
    const inst = ensureInstrument(ctx, t.s);
    return {
      type: 'market.trade' as const,
      payload: {
        venue: 'bybit' as const,
        instrumentId: inst.id,
        tsMs: t.T,
        recvMs,
        tradeId: t.i,
        price: dec(t.p),
        size: dec(t.v),
        side: t.S === 'Buy' ? ('buy' as const) : ('sell' as const),
        quoteCurrency: inst.quoteCurrency,
      },
    };
  });
}

/** Routes one Bybit topic message; response/ack messages yield no events. */
export function handleRawMessage(raw: unknown, ctx: BybitMarketContext): DispatchedEvent[] {
  const msg = BybitWsMessageSchema.safeParse(raw);
  if (!msg.success || !msg.data) return [];
  const { topic, type, ts, data } = msg.data;
  if (!topic || !type) return [];
  const recvMs = ctx.nowMs();

  if (topic.startsWith('tickers.')) return handleTicker(data, ts, ctx, recvMs);
  if (topic.startsWith('orderbook.')) return handleOrderbook(type, data, ts, ctx, recvMs);
  if (topic.startsWith('publicTrade.')) return handleTrades(data, ctx, recvMs);
  return [];
}
