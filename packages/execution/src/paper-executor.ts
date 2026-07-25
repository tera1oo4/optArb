import { dec, type Decimal } from '@optarb/core';
import { computeFeeUsd, type FeeSchedules } from './fees.js';
import { PaperPortfolio } from './paper-portfolio.js';
import type {
  ExecutionIntent,
  ExecutionLeg,
  ExecutionOutcome,
  ExecutionResult,
  PaperFill,
} from './types.js';

export interface PaperExecutorConfig {
  /** Max notional in USD per leg; larger intents are scaled down proportionally */
  maxNotionalUsd: Decimal;
  fees: FeeSchedules;
}

/**
 * Paper executor (ADR-0006): turns an ExecutionIntent into virtual fills at
 * the quoted top-of-book prices carried by the intent (ask for buy legs, bid
 * for sell legs — the intent builder reads them from the consolidated view).
 * Both legs take liquidity, so taker fees apply to both and are deducted from
 * the edge. NO orders are ever sent anywhere; see index.ts for the invariant.
 */
export class PaperExecutor {
  readonly portfolio = new PaperPortfolio();

  constructor(private readonly config: PaperExecutorConfig) {}

  execute(intent: ExecutionIntent): ExecutionOutcome {
    const fills: PaperFill[] = [];
    let grossEdgeUsd = dec(0);
    let feesUsd = dec(0);

    const validations: (string | null)[] = [];
    const scales: Decimal[] = [];
    for (const leg of intent.legs) {
      validations.push(this.validate(leg));
      const fullNotionalUsd = leg.priceUsd.mul(leg.sizeCoin);
      scales.push(
        fullNotionalUsd.lte(this.config.maxNotionalUsd)
          ? dec(1)
          : this.config.maxNotionalUsd.div(fullNotionalUsd),
      );
    }
    const firstReason = validations.find((r) => r !== null);
    if (firstReason !== undefined) {
      return { status: 'skipped', signalId: intent.signalId, reason: firstReason };
    }
    const scale = scales.reduce((min, s) => (s.lt(min) ? s : min));

    for (const leg of intent.legs) {
      const schedule = this.config.fees[leg.venue];
      const sizeCoin = leg.sizeCoin.mul(scale);
      const notionalUsd = leg.priceUsd.mul(sizeCoin);

      const feeUsd = computeFeeUsd(schedule, {
        role: 'taker',
        priceUsd: leg.priceUsd,
        sizeCoin,
        indexPriceUsd: leg.indexPriceUsd,
      });

      const fill: PaperFill = {
        signalId: intent.signalId,
        tsMs: intent.tsMs,
        venue: leg.venue,
        instrumentId: leg.instrumentId,
        viewKey: leg.viewKey,
        underlying: leg.underlying,
        side: leg.side,
        priceUsd: leg.priceUsd,
        sizeCoin,
        notionalUsd,
        feeUsd,
      };
      fills.push(fill);
      this.portfolio.applyFill(fill);

      grossEdgeUsd =
        leg.side === 'sell' ? grossEdgeUsd.add(notionalUsd) : grossEdgeUsd.sub(notionalUsd);
      feesUsd = feesUsd.add(feeUsd);
    }

    const result: ExecutionResult = {
      signalId: intent.signalId,
      signalKind: intent.signalKind,
      fills,
      grossEdgeUsd,
      feesUsd,
      netEdgeUsd: grossEdgeUsd.sub(feesUsd),
    };
    return { status: 'executed', result };
  }

  private validate(leg: ExecutionLeg): string | null {
    if (!leg.priceUsd.isFinite() || leg.priceUsd.lte(0)) {
      return `non-positive price on ${leg.venue}:${leg.instrumentId}`;
    }
    if (!leg.sizeCoin.isFinite() || leg.sizeCoin.lte(0)) {
      return `non-positive size on ${leg.venue}:${leg.instrumentId}`;
    }
    return null;
  }
}
