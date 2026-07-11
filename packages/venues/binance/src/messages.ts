import { z } from 'zod';

/* ------------------------- markPrice (per-symbol entry) ------------------------- */

/** One entry of the `{underlying}usdt@optionMarkPrice` push (whole market, 1s). */
export const MarkPriceEntrySchema = z
  .object({
    e: z.literal('markPrice'),
    E: z.number(),
    s: z.string(),
    /** Mark price (USDT) */
    mp: z.string(),
    /** Index price (USD) */
    i: z.string(),
    /** Best bid/ask prices */
    bo: z.string(),
    ao: z.string(),
    /** Best bid/ask quantities (contracts) */
    bq: z.string(),
    aq: z.string(),
    /** Bid/ask IV as fraction */
    b: z.string(),
    a: z.string(),
    /** Mark IV as fraction (e.g. "0.303") */
    vo: z.string(),
    d: z.string().optional(),
    g: z.string().optional(),
    v: z.string().optional(),
    t: z.string().optional(),
  })
  .passthrough();

export const MarkPriceDataSchema = z.array(MarkPriceEntrySchema);

/* ------------------------------ depth (diff) ------------------------------ */

const BookLevelSchema = z.tuple([z.string(), z.string()]);

/** Futures-style diff depth (`{symbol}@depth10@100ms`): changed levels only, pu-chained. */
export const DepthUpdateSchema = z
  .object({
    e: z.literal('depthUpdate'),
    E: z.number(),
    T: z.number(),
    s: z.string(),
    /** First update id in this event */
    U: z.number(),
    /** Final update id in this event */
    u: z.number(),
    /** Update id of the previous event — must equal last applied u */
    pu: z.number(),
    b: z.array(BookLevelSchema).default([]),
    a: z.array(BookLevelSchema).default([]),
  })
  .passthrough();

/** REST GET /eapi/v1/depth snapshot */
export const RestDepthSchema = z
  .object({
    lastUpdateId: z.number(),
    bids: z.array(BookLevelSchema),
    asks: z.array(BookLevelSchema),
  })
  .passthrough();

/* -------------------------------- trades -------------------------------- */

export const OptionTradeSchema = z
  .object({
    e: z.literal('trade'),
    E: z.number(),
    T: z.number(),
    s: z.string(),
    t: z.number(),
    p: z.string(),
    q: z.string(),
    /** Taker side when present */
    S: z.enum(['BUY', 'SELL']).optional(),
    /** Buyer is maker (taker sold) */
    m: z.boolean().optional(),
  })
  .passthrough();

/* ------------------------------ ws envelope ------------------------------ */

export const BinanceWsMessageSchema = z
  .object({
    stream: z.string().optional(),
    data: z.unknown().optional(),
    result: z.unknown().optional(),
    id: z.number().optional(),
  })
  .passthrough();
