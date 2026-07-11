import type { Decimal } from './decimal.js';

export const VENUES = ['deribit', 'binance', 'bybit', 'okx', 'polymarket'] as const;
export type Venue = (typeof VENUES)[number];

export type Underlying = 'BTC' | 'ETH';
export type InstrumentKind = 'option' | 'future' | 'perpetual' | 'binary';
export type OptionType = 'call' | 'put';
export type Side = 'buy' | 'sell';
export type QuoteCurrency = 'USD' | 'USDT' | 'USDC' | 'BTC' | 'ETH';

/** Normalized instrument across all venues (ADR-0003). Specs always come from venue APIs. */
export interface Instrument {
  /** Stable internal id: `${venue}:${venueSymbol}` */
  id: string;
  venue: Venue;
  venueSymbol: string;
  kind: InstrumentKind;
  underlying: Underlying;
  /** Expiry in epoch ms UTC; null for perpetuals */
  expiryMs: number | null;
  /** Strike in USD; null for non-options */
  strike: Decimal | null;
  optionType: OptionType | null;
  /** Base-asset units per contract (e.g. 1 for Deribit BTC options) */
  contractMultiplier: Decimal;
  /** Currency the price is quoted in (BTC on Deribit, USDT on Binance, ...) */
  quoteCurrency: QuoteCurrency;
  settleCurrency: QuoteCurrency;
}

export function instrumentId(venue: Venue, venueSymbol: string): string {
  return `${venue}:${venueSymbol}`;
}

export interface PriceLevel {
  price: Decimal;
  /** Size in contracts */
  size: Decimal;
}

export interface BookUpdate {
  venue: Venue;
  instrumentId: string;
  /** Exchange timestamp, epoch ms */
  tsMs: number;
  /** Local receive timestamp, epoch ms */
  recvMs: number;
  sequence: number | null;
  /** Descending by price */
  bids: PriceLevel[];
  /** Ascending by price */
  asks: PriceLevel[];
  quoteCurrency: QuoteCurrency;
}

export interface TradeUpdate {
  venue: Venue;
  instrumentId: string;
  tsMs: number;
  recvMs: number;
  tradeId: string;
  price: Decimal;
  /** Size in contracts */
  size: Decimal;
  /** Taker side */
  side: Side;
  quoteCurrency: QuoteCurrency;
}

export interface Greeks {
  delta?: Decimal;
  gamma?: Decimal;
  vega?: Decimal;
  theta?: Decimal;
  rho?: Decimal;
}

export interface TickerUpdate {
  venue: Venue;
  instrumentId: string;
  tsMs: number;
  recvMs: number;
  markPrice: Decimal | null;
  /** USD price of 1 unit of underlying at this venue */
  indexPrice: Decimal | null;
  /** Annualized implied volatility as fraction (0.55 = 55%) */
  markIv: Decimal | null;
  greeks: Greeks | null;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  quoteCurrency: QuoteCurrency;
}

export type ConnectorState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface ConnectorStatus {
  venue: Venue;
  state: ConnectorState;
  tsMs: number;
  detail?: string;
}
