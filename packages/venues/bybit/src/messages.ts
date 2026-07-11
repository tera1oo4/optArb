import { z } from 'zod';
import { dec, type Decimal } from '@optarb/core';

/** Bybit numeric fields arrive as strings; empty string means "no value". */
export function numOrNull(s: string | undefined): Decimal | null {
  return s === undefined || s === '' ? null : dec(s);
}

/* ------------------------------- ticker ------------------------------- */

export const BybitTickerDataSchema = z
  .object({
    symbol: z.string(),
    bidPrice: z.string().optional(),
    bidSize: z.string().optional(),
    askPrice: z.string().optional(),
    askSize: z.string().optional(),
    lastPrice: z.string().optional(),
    markPrice: z.string().optional(),
    /** IV as fraction (e.g. "0.4254"), already NOT percent */
    markPriceIv: z.string().optional(),
    indexPrice: z.string().optional(),
    delta: z.string().optional(),
    gamma: z.string().optional(),
    theta: z.string().optional(),
    vega: z.string().optional(),
  })
  .passthrough();

/* ------------------------------ orderbook ------------------------------ */

const BookLevelSchema = z.tuple([z.string(), z.string()]);

export const BybitOrderbookDataSchema = z
  .object({
    s: z.string(),
    b: z.array(BookLevelSchema).default([]),
    a: z.array(BookLevelSchema).default([]),
    /** Per-symbol update id; delta continuity rule: u === prevU + 1 */
    u: z.number(),
    seq: z.number().optional(),
  })
  .passthrough();

/* ------------------------------- trades ------------------------------- */

export const BybitTradeSchema = z
  .object({
    i: z.string(),
    T: z.number(),
    s: z.string(),
    S: z.enum(['Buy', 'Sell']),
    v: z.string(),
    p: z.string(),
  })
  .passthrough();

export const BybitTradesDataSchema = z.array(BybitTradeSchema);

/* ------------------------------ ws envelope ------------------------------ */

export const BybitWsMessageSchema = z
  .object({
    topic: z.string().optional(),
    type: z.enum(['snapshot', 'delta']).optional(),
    ts: z.number().optional(),
    data: z.unknown().optional(),
    op: z.string().optional(),
    id: z.string().optional(),
    success: z.boolean().optional(),
    ret_msg: z.string().optional(),
  })
  .passthrough();
