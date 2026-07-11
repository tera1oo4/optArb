import { z } from 'zod';

/* ------------------------------ Gamma REST ------------------------------ */

/**
 * Gamma API market record. Only the fields we rely on are declared;
 * `outcomes` and `clobTokenIds` are JSON-encoded arrays inside strings.
 */
export const GammaMarketSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    conditionId: z.string(),
    slug: z.string().optional(),
    endDate: z.string(),
    outcomes: z.string(),
    clobTokenIds: z.string(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    acceptingOrders: z.boolean().optional(),
    negRisk: z.boolean().optional(),
  })
  .passthrough();

export const GammaMarketsResponseSchema = z.array(GammaMarketSchema);

/** Parses a Gamma JSON-encoded string array (`"[\"Yes\", \"No\"]"`); null on failure. */
export function parseGammaStringArray(raw: string): string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = z.array(z.string()).safeParse(json);
  return parsed.success ? parsed.data : null;
}

/* --------------------------- CLOB WS market channel --------------------------- */

const BookLevelSchema = z.object({ price: z.string(), size: z.string() }).passthrough();

/** `book` — full snapshot, sent on subscribe and after book-affecting trades. */
export const PolyBookEventSchema = z
  .object({
    event_type: z.literal('book'),
    asset_id: z.string(),
    market: z.string().optional(),
    // NOTE: WS book levels may arrive worst-first; L2Book.top() re-sorts anyway.
    bids: z.array(BookLevelSchema).default([]),
    asks: z.array(BookLevelSchema).default([]),
    timestamp: z.string(),
    hash: z.string().optional(),
  })
  .passthrough();

/** `price_change` — delta per level; size "0" removes the level. */
export const PolyPriceChangeEventSchema = z
  .object({
    event_type: z.literal('price_change'),
    market: z.string().optional(),
    price_changes: z.array(
      z
        .object({
          asset_id: z.string(),
          price: z.string(),
          size: z.string(),
          side: z.enum(['BUY', 'SELL']),
          best_bid: z.string().optional(),
          best_ask: z.string().optional(),
          hash: z.string().optional(),
        })
        .passthrough(),
    ),
    timestamp: z.string(),
  })
  .passthrough();

/** `last_trade_price` — matched trade print; has no trade id of its own. */
export const PolyLastTradeEventSchema = z
  .object({
    event_type: z.literal('last_trade_price'),
    asset_id: z.string(),
    market: z.string().optional(),
    price: z.string(),
    size: z.string(),
    side: z.enum(['BUY', 'SELL']),
    timestamp: z.string(),
  })
  .passthrough();

/** `best_bid_ask` — requires custom_feature_enabled in the subscribe frame. */
export const PolyBestBidAskEventSchema = z
  .object({
    event_type: z.literal('best_bid_ask'),
    asset_id: z.string(),
    market: z.string().optional(),
    best_bid: z.string(),
    best_ask: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

/** Discriminator: every market-channel event carries event_type; `{}` is a heartbeat ack. */
export const PolyWsEnvelopeSchema = z
  .object({
    event_type: z.string().optional(),
  })
  .passthrough();
