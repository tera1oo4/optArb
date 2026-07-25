import { dec, type Decimal, type Logger } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import { computeFeeUsd, type FeeSchedules } from './fees.js';
import { OmsEngine } from './oms-engine.js';
import { PaperPortfolio } from './paper-portfolio.js';
import type { OrderAttempt, OrderCommandSender, OrderEvent } from './oms-types.js';
import type { PaperFill } from './types.js';

export interface PaperOrderSimulatorConfig {
  /** Slippage in basis points; makes buys more expensive and sells cheaper. */
  slippageBps: Decimal;
  fees: FeeSchedules;
  logger?: Logger;
}

/**
 * Paper-only command sender (M9). It "submits" orders, immediately acks them,
 * then fills them at the top-of-book from the supplied consolidated view,
 * optionally worsening the price by `slippageBps`. It never touches a real
 * venue API.
 */
export class PaperOrderSimulator implements OrderCommandSender {
  constructor(
    private readonly engine: OmsEngine,
    private readonly portfolio: PaperPortfolio,
    private readonly config: PaperOrderSimulatorConfig,
  ) {}

  submit(attempt: OrderAttempt, legIndex: number, views: InstrumentView[], nowMs: number): void {
    const leg = attempt.legs[legIndex];
    if (!leg) return;

    const ackEvent: OrderEvent = { kind: 'ack', tsMs: nowMs };
    this.engine.onOrderEvent(attempt.id, legIndex, ackEvent, nowMs);

    const fillPrice = this.fillPrice(leg, views);
    const sizeCoin = leg.requestedSizeCoin;
    const notionalUsd = fillPrice.mul(sizeCoin);
    const feeUsd = computeFeeUsd(this.config.fees[leg.venue], {
      role: 'taker',
      priceUsd: fillPrice,
      sizeCoin,
      indexPriceUsd: leg.indexPriceUsd,
    });

    const fill: PaperFill = {
      signalId: attempt.signalId,
      tsMs: nowMs,
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      viewKey: leg.viewKey,
      underlying: leg.underlying,
      side: leg.side,
      priceUsd: fillPrice,
      sizeCoin,
      notionalUsd,
      feeUsd,
    };

    this.portfolio.applyFill(fill);

    const fillEvent: OrderEvent = {
      kind: 'fill',
      tsMs: nowMs,
      priceUsd: fillPrice,
      sizeCoin,
      feeUsd,
    };
    this.engine.onOrderEvent(attempt.id, legIndex, fillEvent, nowMs);

    this.config.logger?.debug('paper order filled', {
      attemptId: attempt.id,
      legIndex,
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      side: leg.side,
      priceUsd: fillPrice.toString(),
      sizeCoin: sizeCoin.toString(),
      feeUsd: feeUsd.toString(),
    });
  }

  cancel(attempt: OrderAttempt, legIndex: number, _views: InstrumentView[], nowMs: number): void {
    const leg = attempt.legs[legIndex];
    if (!leg) return;
    this.engine.onOrderEvent(
      attempt.id,
      legIndex,
      { kind: 'cancel', tsMs: nowMs, reason: 'paper cancel' },
      nowMs,
    );
  }

  private fillPrice(leg: OrderAttempt['legs'][number], views: InstrumentView[]): Decimal {
    const view = views.find((v) => v.key === leg.viewKey);
    const quote = view?.quotes.get(leg.venue);
    let basePrice = leg.requestedPriceUsd;
    if (leg.side === 'buy') {
      const ask = quote?.askUsd;
      if (ask !== null && ask !== undefined) basePrice = ask;
    } else {
      const bid = quote?.bidUsd;
      if (bid !== null && bid !== undefined) basePrice = bid;
    }

    const slippage = this.config.slippageBps.div(10000);
    return leg.side === 'buy'
      ? basePrice.mul(dec(1).add(slippage))
      : basePrice.mul(dec(1).sub(slippage));
  }
}
