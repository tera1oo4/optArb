import type { Logger, Venue } from '@optarb/core';
import type { GatewayOrderEvent, OrderGateway, OrderRequest } from '../order-gateway.js';

/**
 * Safe default order gateway used when live trading is enabled but a venue has
 * no real adapter configured. It logs the order and immediately rejects it, so
 * no real orders can be sent accidentally.
 */
export class StubOrderGateway implements OrderGateway {
  readonly venue: Venue;
  private readonly logger?: Logger;

  constructor(venue: Venue, logger?: Logger) {
    this.venue = venue;
    this.logger = logger;
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
      tsMs: Date.now(),
      reason: `live trading not configured for ${this.venue}`,
    });
  }

  async cancel(_exchangeOrderId: string): Promise<void> {
    // Nothing to cancel — the order never reached a real exchange.
  }
}
