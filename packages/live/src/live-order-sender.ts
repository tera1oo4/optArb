import { dec, type Logger, type Venue } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import type { AuditWriter, AuditFillInput } from '@optarb/persistence';
import {
  computeFeeUsd,
  OmsEngine,
  PaperPortfolio,
  type FeeSchedules,
  type OrderAttempt,
  type OrderCommandSender,
  type OrderEvent,
  type PaperFill,
} from '@optarb/execution';
import type { GatewayOrderEvent, OrderGateway, OrderRequest } from './order-gateway.js';

export interface LiveOrderSenderConfig {
  gateways: Map<Venue, OrderGateway>;
  engine: OmsEngine;
  portfolio: PaperPortfolio;
  fees: FeeSchedules;
  audit: AuditWriter;
  logger?: Logger;
}

/**
 * Bridges the paper OMS engine to real venue order gateways.
 *
 * - Converts OMS `submit`/`cancel` calls into gateway requests.
 * - Forwards gateway lifecycle events back into the OMS engine.
 * - Applies confirmed fills to the paper portfolio and writes them to the audit
 *   log so that live and paper share the same PnL/audit pipeline.
 *
 * This implementation is intentionally gateway-agnostic: stubs reject every
 * order, and real adapters can be injected per venue.
 */
export class LiveOrderSender implements OrderCommandSender {
  private readonly config: LiveOrderSenderConfig;
  private readonly exchangeIds = new Map<string, string>(); // key: attemptId|legIndex

  constructor(config: LiveOrderSenderConfig) {
    this.config = config;
  }

  submit(attempt: OrderAttempt, legIndex: number, views: InstrumentView[], nowMs: number): void {
    const leg = attempt.legs[legIndex];
    if (!leg) return;

    const gateway = this.config.gateways.get(leg.venue);
    if (!gateway) {
      this.config.engine.onOrderEvent(
        attempt.id,
        legIndex,
        { kind: 'reject', tsMs: nowMs, reason: `no gateway for ${leg.venue}` },
        nowMs,
      );
      return;
    }

    const view = views.find((v) => v.quotes.get(leg.venue)?.instrumentId === leg.instrumentId);
    const quote = view?.quotes.get(leg.venue);

    const req: OrderRequest = {
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      side: leg.side,
      sizeCoin: leg.requestedSizeCoin,
      priceUsd: leg.requestedPriceUsd,
      indexPriceUsd: quote?.indexPriceUsd ?? leg.indexPriceUsd ?? undefined,
      contractMultiplier: quote?.contractMultiplier ?? undefined,
      signalId: attempt.signalId,
      attemptId: attempt.id,
      legIndex,
    };

    const onEvent = (event: GatewayOrderEvent): void => {
      if (event.kind === 'ack') {
        this.exchangeIds.set(this.routingKey(attempt.id, legIndex), event.exchangeOrderId);
      }

      const omsEvent = this.toOmsEvent(event);
      this.config.engine.onOrderEvent(attempt.id, legIndex, omsEvent, event.tsMs);

      if (event.kind === 'fill' || event.kind === 'partial_fill') {
        void this.handleFill(attempt.id, legIndex);
      }
    };

    gateway.submit(req, onEvent).catch((err: unknown) => {
      this.config.logger?.error('gateway submit failed', {
        venue: leg.venue,
        instrumentId: leg.instrumentId,
        err: String(err),
      });
      onEvent({
        kind: 'reject',
        tsMs: Date.now(),
        reason: `gateway error: ${String(err)}`,
      });
    });
  }

  cancel(attempt: OrderAttempt, legIndex: number, _views: InstrumentView[], _nowMs: number): void {
    const exchangeOrderId = this.exchangeIds.get(this.routingKey(attempt.id, legIndex));
    if (!exchangeOrderId) return;
    const leg = attempt.legs[legIndex];
    if (!leg) return;
    const gateway = this.config.gateways.get(leg.venue);
    if (!gateway) return;

    gateway.cancel(exchangeOrderId).catch((err: unknown) => {
      this.config.logger?.error('gateway cancel failed', {
        venue: leg.venue,
        exchangeOrderId,
        err: String(err),
      });
    });
  }

  private routingKey(attemptId: string, legIndex: number): string {
    return `${attemptId}|${legIndex}`;
  }

  private toOmsEvent(event: GatewayOrderEvent): OrderEvent {
    switch (event.kind) {
      case 'ack':
        return { kind: 'ack', tsMs: event.tsMs };
      case 'fill':
        return {
          kind: 'fill',
          tsMs: event.tsMs,
          priceUsd: event.priceUsd,
          sizeCoin: event.sizeCoin,
          feeUsd: event.feeUsd,
        };
      case 'partial_fill':
        return {
          kind: 'partial_fill',
          tsMs: event.tsMs,
          priceUsd: event.priceUsd,
          sizeCoin: event.sizeCoin,
          feeUsd: event.feeUsd,
        };
      case 'cancel':
        return { kind: 'cancel', tsMs: event.tsMs, reason: event.reason };
      case 'reject':
        return { kind: 'reject', tsMs: event.tsMs, reason: event.reason };
      case 'expire':
        return { kind: 'expire', tsMs: event.tsMs, reason: event.reason };
    }
  }

  private async handleFill(attemptId: string, legIndex: number): Promise<void> {
    const attempt = this.config.engine.getAttempt(attemptId);
    if (!attempt) return;
    const leg = attempt.legs[legIndex];
    if (!leg) return;

    // The OMS engine appends each fill/partial_fill to attempt.fills.
    // Find the most recent fill for this leg by matching venue+instrumentId+side.
    const fill = this.findLatestFill(attempt, leg);
    if (!fill) return;

    this.config.portfolio.applyFill(fill);

    const auditFill: AuditFillInput = {
      signalId: fill.signalId,
      tsMs: fill.tsMs,
      venue: fill.venue,
      instrumentId: fill.instrumentId,
      viewKey: fill.viewKey,
      underlying: fill.underlying,
      side: fill.side,
      priceUsd: fill.priceUsd,
      sizeCoin: fill.sizeCoin,
      notionalUsd: fill.notionalUsd,
      feeUsd: fill.feeUsd,
    };

    try {
      await this.config.audit.writeFills('live', [auditFill]);
    } catch (err) {
      this.config.logger?.error('failed to audit live fill', {
        attemptId,
        legIndex,
        err: String(err),
      });
    }
  }

  private findLatestFill(
    attempt: OrderAttempt,
    leg: OrderAttempt['legs'][number],
  ): PaperFill | undefined {
    for (let i = attempt.fills.length - 1; i >= 0; i--) {
      const f = attempt.fills[i];
      if (
        f &&
        f.venue === leg.venue &&
        f.instrumentId === leg.instrumentId &&
        f.side === leg.side
      ) {
        return f;
      }
    }
    return undefined;
  }
}
