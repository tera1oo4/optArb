import { LiveClock, type Clock, type Logger, type Venue } from '@optarb/core';
import type { GatewayOrderEvent, OrderGateway, OrderRequest } from '../order-gateway.js';

/**
 * Safe default order gateway used when live trading is enabled but a venue has
 * no real adapter configured. It logs the order and immediately rejects it, so
 * no real orders can be sent accidentally.
 */
export class StubOrderGateway implements OrderGateway {
  readonly venue: Venue;
  private readonly logger?: Logger;
  private readonly clock: Clock;

  constructor(venue: Venue, logger?: Logger, clock?: Clock) {
    this.venue = venue;
    this.logger = logger;
    this.clock = clock ?? new LiveClock();
  }

  async submit(req: OrderRequest, onEvent: (event: GatewayOrderEvent) => void): Promise<void> {
    this.logger?.warn('live order rejected: stub gateway', {
      venue: this.venue,
      instrumentId: req.instrumentId,
      side: req.side,
      sizeCoin: req.sizeCoin.toString(),
      priceUsd: req.priceUsd.toString(),
      signalId: req.signalId,
      attemptId: req.attemptId,
      legIndex: req.legIndex,
    });

    onEvent({
      kind: 'reject',
      tsMs: this.clock.nowMs(),
      reason: `live trading not configured for ${this.venue}`,
    });
  }

  async cancel(_exchangeOrderId: string): Promise<void> {
    // Nothing to cancel — the order never reached a real exchange.
  }
}
