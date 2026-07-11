import { z } from 'zod';
import { dec, type Decimal } from '@optarb/core';

/** OKX numeric fields arrive as strings; empty string means "no value". */
export function numOrNull(s: string | undefined): Decimal | null {
  return s === undefined || s === '' ? null : dec(s);
}

/* ------------------------------- ticker ------------------------------- */

export const OkxTickerDataSchema = z
  .object({
    instId: z.string(),
    bidPx: z.string().optional(),
    bidSz: z.string().optional(),
    askPx: z.string().optional(),
    askSz: z.string().optional(),
    last: z.string().optional(),
    markPx: z.string().optional(),
    idxPx: z.string().optional(),
    /** Mark volatility as fraction (option tickers only) */
    markVol: z.string().optional(),
    delta: z.string().optional(),
    gamma: z.string().optional(),
    theta: z.string().optional(),
    vega: z.string().optional(),
    ts: z.string(),
  })
  .passthrough();

/* ------------------------- index-tickers / mark-price ------------------------- */

/** `index-tickers` channel: index price for the underlying (e.g. BTC-USD). */
export const OkxIndexTickerSchema = z
  .object({
    instId: z.string(),
    idxPx: z.string(),
    ts: z.string(),
  })
  .passthrough();

/** `mark-price` channel: mark price per option (coin-denominated). */
export const OkxMarkPriceSchema = z
  .object({
    instId: z.string(),
    markPx: z.string(),
    ts: z.string(),
  })
  .passthrough();

/* ------------------------------- books5 ------------------------------- */

/** [price, size, deprecated, orderCount] — full top-5 book per push */
const BookLevelSchema = z.tuple([z.string(), z.string()]).rest(z.string());

export const OkxBooks5DataSchema = z
  .object({
    asks: z.array(BookLevelSchema).default([]),
    bids: z.array(BookLevelSchema).default([]),
    seqId: z.number().optional(),
    prevSeqId: z.number().optional(),
    ts: z.string(),
  })
  .passthrough();

/* ------------------------------- trades ------------------------------- */

export const OkxTradeSchema = z
  .object({
    instId: z.string(),
    tradeId: z.string(),
    px: z.string(),
    sz: z.string(),
    side: z.enum(['buy', 'sell']),
    ts: z.string(),
  })
  .passthrough();

/* ------------------------------ ws envelope ------------------------------ */

export const OkxWsMessageSchema = z
  .object({
    arg: z
      .object({
        channel: z.string(),
        instId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    action: z.enum(['snapshot', 'update']).optional(),
    data: z.array(z.unknown()).optional(),
    event: z.string().optional(),
    code: z.string().optional(),
    msg: z.string().optional(),
  })
  .passthrough();
