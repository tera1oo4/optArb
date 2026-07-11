import { z } from 'zod';
import {
  dec,
  instrumentId,
  type AppEventMap,
  type AppEventType,
  type Instrument,
} from '@optarb/core';
import { BookBuilder } from './book-builder.js';
import { parseBookData, parseTickerData, parseTradesData } from './messages.js';
import { parseInstrumentName } from './symbols.js';

/** An event with type/payload correlated by construction. */
export interface DispatchedEvent {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
}

/**
 * Shared normalization context used identically by the live connector and by
 * replay (ADR-0004): same code path, only the message source differs.
 */
export interface DeribitMarketContext {
  instruments: Map<string, Instrument>;
  books: Map<string, BookBuilder>;
  bookDepth: number;
  nowMs: () => number;
}

export function createMarketContext(opts?: {
  bookDepth?: number;
  nowMs?: () => number;
}): DeribitMarketContext {
  return {
    instruments: new Map(),
    books: new Map(),
    bookDepth: opts?.bookDepth ?? 10,
    nowMs: opts?.nowMs ?? Date.now,
  };
}

export function ensureInstrument(ctx: DeribitMarketContext, venueSymbol: string): Instrument {
  let inst = ctx.instruments.get(venueSymbol);
  if (!inst) {
    const p = parseInstrumentName(venueSymbol);
    inst = {
      id: instrumentId('deribit', venueSymbol),
      venue: 'deribit',
      venueSymbol,
      kind: p.kind,
      underlying: p.underlying,
      expiryMs: p.expiryMs,
      strike: p.strike,
      optionType: p.optionType,
      // Deribit BTC/ETH options: 1 contract = 1 coin, premium quoted in coin
      contractMultiplier: dec(1),
      quoteCurrency: p.underlying,
      settleCurrency: p.underlying,
    };
    ctx.instruments.set(venueSymbol, inst);
  }
  return inst;
}

export function handleChannelMessage(
  channel: string,
  data: unknown,
  ctx: DeribitMarketContext,
): DispatchedEvent[] {
  const recvMs = ctx.nowMs();

  if (channel.startsWith('ticker.')) {
    const t = parseTickerData(data);
    const inst = ensureInstrument(ctx, t.instrument);
    return [
      {
        type: 'market.ticker',
        payload: {
          venue: 'deribit',
          instrumentId: inst.id,
          tsMs: t.tsMs,
          recvMs,
          markPrice: t.markPrice,
          indexPrice: t.indexPrice,
          markIv: t.markIv,
          greeks: t.greeks,
          bestBid: t.bestBid,
          bestAsk: t.bestAsk,
          quoteCurrency: inst.quoteCurrency,
        },
      },
    ];
  }

  if (channel.startsWith('book.')) {
    const msg = parseBookData(data);
    const inst = ensureInstrument(ctx, msg.instrument);
    let builder = ctx.books.get(msg.instrument);
    if (!builder) {
      builder = new BookBuilder(msg.instrument);
      ctx.books.set(msg.instrument, builder);
    }
    // Throws SequenceGapError on gap — the caller decides the resync policy.
    builder.apply(msg);
    const { bids, asks } = builder.top(ctx.bookDepth);
    return [
      {
        type: 'market.book',
        payload: {
          venue: 'deribit',
          instrumentId: inst.id,
          tsMs: msg.tsMs,
          recvMs,
          sequence: msg.changeId,
          bids,
          asks,
          quoteCurrency: inst.quoteCurrency,
        },
      },
    ];
  }

  if (channel.startsWith('trades.')) {
    return parseTradesData(data).map((tr) => {
      const inst = ensureInstrument(ctx, tr.instrument);
      return {
        type: 'market.trade' as const,
        payload: {
          venue: 'deribit' as const,
          instrumentId: inst.id,
          tsMs: tr.tsMs,
          recvMs,
          tradeId: tr.tradeId,
          price: tr.price,
          size: tr.size,
          side: tr.side,
          quoteCurrency: inst.quoteCurrency,
        },
      };
    });
  }

  return [];
}

const SubscriptionEnvelope = z
  .object({
    method: z.string(),
    params: z
      .object({
        channel: z.string(),
        data: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

/** Routes a raw JSON-RPC message; non-subscription messages yield no events. */
export function handleRawMessage(raw: unknown, ctx: DeribitMarketContext): DispatchedEvent[] {
  const parsed = SubscriptionEnvelope.safeParse(raw);
  if (!parsed.success || parsed.data.method !== 'subscription') return [];
  return handleChannelMessage(parsed.data.params.channel, parsed.data.params.data, ctx);
}
