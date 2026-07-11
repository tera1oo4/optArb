import { z } from 'zod';
import { dec, type Decimal } from '@optarb/core';
import type { BookAction } from './book-builder.js';

/* -------------------------------- book -------------------------------- */

const BookLevelSchema = z.union([
  z.tuple([z.enum(['new', 'change', 'delete']), z.number(), z.number()]),
  // Snapshot levels on some channels arrive as plain [price, amount]
  z.tuple([z.number(), z.number()]),
]);

export const BookDataSchema = z
  .object({
    // Interval channels (.100ms) deliver full snapshots without `type`/`prev_change_id`;
    // .raw channels send typed snapshot/change with prev_change_id sequencing.
    type: z.enum(['snapshot', 'change']).optional(),
    timestamp: z.number(),
    instrument_name: z.string(),
    change_id: z.number(),
    prev_change_id: z.number().nullable().optional(),
    bids: z.array(BookLevelSchema),
    asks: z.array(BookLevelSchema),
  })
  .passthrough();

export interface ParsedBookLevel {
  action: BookAction;
  price: Decimal;
  amount: Decimal;
}

export interface ParsedBookData {
  type: 'snapshot' | 'change';
  tsMs: number;
  instrument: string;
  changeId: number;
  prevChangeId: number | null;
  bids: ParsedBookLevel[];
  asks: ParsedBookLevel[];
}

export function parseBookData(raw: unknown): ParsedBookData {
  const d = BookDataSchema.parse(raw);
  const mapLevels = (levels: z.infer<typeof BookLevelSchema>[]): ParsedBookLevel[] =>
    levels.map((level) =>
      level.length === 2
        ? { action: 'new', price: dec(level[0]), amount: dec(level[1]) }
        : { action: level[0], price: dec(level[1]), amount: dec(level[2]) },
    );
  return {
    type: d.type ?? 'snapshot',
    tsMs: d.timestamp,
    instrument: d.instrument_name,
    changeId: d.change_id,
    prevChangeId: d.prev_change_id ?? null,
    bids: mapLevels(d.bids),
    asks: mapLevels(d.asks),
  };
}

/* ------------------------------- ticker ------------------------------- */

export const TickerDataSchema = z
  .object({
    instrument_name: z.string(),
    timestamp: z.number(),
    best_bid_price: z.number().nullable().optional(),
    best_ask_price: z.number().nullable().optional(),
    mark_price: z.number().nullable().optional(),
    index_price: z.number().nullable().optional(),
    mark_iv: z.number().nullable().optional(),
    greeks: z
      .object({
        delta: z.number().optional(),
        gamma: z.number().optional(),
        vega: z.number().optional(),
        theta: z.number().optional(),
        rho: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export interface ParsedGreeks {
  delta?: Decimal;
  gamma?: Decimal;
  vega?: Decimal;
  theta?: Decimal;
  rho?: Decimal;
}

export interface ParsedTickerData {
  instrument: string;
  tsMs: number;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  markPrice: Decimal | null;
  indexPrice: Decimal | null;
  /** Annualized IV as fraction (Deribit sends percent; converted here) */
  markIv: Decimal | null;
  greeks: ParsedGreeks | null;
}

export function parseTickerData(raw: unknown): ParsedTickerData {
  const d = TickerDataSchema.parse(raw);
  return {
    instrument: d.instrument_name,
    tsMs: d.timestamp,
    bestBid: d.best_bid_price != null ? dec(d.best_bid_price) : null,
    bestAsk: d.best_ask_price != null ? dec(d.best_ask_price) : null,
    markPrice: d.mark_price != null ? dec(d.mark_price) : null,
    indexPrice: d.index_price != null ? dec(d.index_price) : null,
    markIv: d.mark_iv != null ? dec(d.mark_iv).div(100) : null,
    greeks: d.greeks
      ? {
          delta: d.greeks.delta != null ? dec(d.greeks.delta) : undefined,
          gamma: d.greeks.gamma != null ? dec(d.greeks.gamma) : undefined,
          vega: d.greeks.vega != null ? dec(d.greeks.vega) : undefined,
          theta: d.greeks.theta != null ? dec(d.greeks.theta) : undefined,
          rho: d.greeks.rho != null ? dec(d.greeks.rho) : undefined,
        }
      : null,
  };
}

/* ------------------------------- trades ------------------------------- */

export const TradeItemSchema = z
  .object({
    trade_id: z.string(),
    instrument_name: z.string(),
    price: z.number(),
    amount: z.number(),
    direction: z.enum(['buy', 'sell']),
    timestamp: z.number(),
  })
  .passthrough();

export const TradesDataSchema = z.array(TradeItemSchema);

export interface ParsedTrade {
  tradeId: string;
  instrument: string;
  price: Decimal;
  size: Decimal;
  side: 'buy' | 'sell';
  tsMs: number;
}

export function parseTradesData(raw: unknown): ParsedTrade[] {
  return TradesDataSchema.parse(raw).map((t) => ({
    tradeId: t.trade_id,
    instrument: t.instrument_name,
    price: dec(t.price),
    size: dec(t.amount),
    side: t.direction,
    tsMs: t.timestamp,
  }));
}
