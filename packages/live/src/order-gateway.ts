import type { Decimal, Side, Venue } from '@optarb/core';

/**
 * Normalised order request sent to a venue order gateway.
 *
 * `priceUsd` is a guard price (limit or worst-acceptable for a market order),
 * not the price we expect to fill at. The gateway is responsible for choosing
 * the concrete order type permitted by the venue while respecting the guard.
 */
export interface OrderRequest {
  venue: Venue;
  instrumentId: string;
  side: Side;
  sizeCoin: Decimal;
  priceUsd: Decimal;
  signalId: string;
  attemptId: string;
  legIndex: number;
}

export type GatewayOrderEvent =
  | { kind: 'ack'; tsMs: number; exchangeOrderId: string }
  | { kind: 'fill'; tsMs: number; priceUsd: Decimal; sizeCoin: Decimal; feeUsd?: Decimal }
  | { kind: 'partial_fill'; tsMs: number; priceUsd: Decimal; sizeCoin: Decimal; feeUsd?: Decimal }
  | { kind: 'cancel'; tsMs: number; reason?: string }
  | { kind: 'reject'; tsMs: number; reason: string }
  | { kind: 'expire'; tsMs: number; reason?: string };

/**
 * Venue-specific order gateway. Implementations hide exchange idiosyncrasies
 * (REST signatures, order types, decimal precision) behind a normalised event
 * callback.
 */
export interface OrderGateway {
  readonly venue: Venue;
  submit(req: OrderRequest, onEvent: (event: GatewayOrderEvent) => void): Promise<void>;
  cancel(exchangeOrderId: string): Promise<void>;
}
