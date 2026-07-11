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
export interface OkxMarketContext {
  instruments: Map<string, Instrument>;
  books: Map<string, L2Book>;
  tickerState: Map<string, TickerState>;
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
      quoteCurrency: 'USD',
      settleCurrency: p.underlying,
    };
    ctx.instruments.set(instId, inst);
  }
  return inst;
}

function handleTicker(data: unknown, ctx: OkxMarketContext, recvMs: number): DispatchedEvent[] {
  const t = OkxTickerDataSchema.parse(data);
  const inst = ensureInstrument(ctx, t.instId);
  let st = ctx.tickerState.get(t.instId);
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
    ctx.tickerState.set(t.instId, st);
  }
  const merge = (field: keyof TickerState, raw: string | undefined) => {
    const v = numOrNull(raw);
    if (v !== null) st[field] = v;
  };
  merge('markPrice', t.markPx);
  merge('indexPrice', t.idxPx);
  merge('markIv', t.markVol);
  merge('bestBid', t.bidPx);
  merge('bestAsk', t.askPx);
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
        venue: 'okx',
        instrumentId: inst.id,
        tsMs: Number(t.ts),
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
    else if (channel === 'books5' && instId)
      events.push(...handleBooks5(instId, item, ctx, recvMs));
    else if (channel === 'trades') events.push(...handleTrade(item, ctx, recvMs));
  }
  return events;
}
