import { dec, type Decimal, type Logger } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import { computeFeeUsd, type FeeSchedules } from './fees.js';
import { OmsEngine } from './oms-engine.js';
import { PaperOrderSimulator } from './paper-order-simulator.js';
import { PaperPortfolio } from './paper-portfolio.js';
import type { OmsStats } from './oms-types.js';
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
  /** Optional OMS mode (M9). When disabled the executor keeps the legacy atomic fill path. */
  oms?: {
    enabled: boolean;
    legTimeoutMs: number;
    maxAttempts: number;
    slippageBps: Decimal;
  };
  logger?: Logger;
}

/**
 * Paper executor (ADR-0006, M9). By default it atomically fills both legs at
 * the prices carried by the intent. When OMS mode is enabled it instead runs
 * the two-legged order through the OmsEngine + PaperOrderSimulator state
 * machine, still without sending any real orders.
 */
export class PaperExecutor {
  readonly portfolio = new PaperPortfolio();
  private readonly omsEngine?: OmsEngine;
  private readonly config: PaperExecutorConfig;

  constructor(config: PaperExecutorConfig) {
    this.config = config;
    if (config.oms?.enabled) {
      const engine = new OmsEngine({
        timeoutMs: config.oms.legTimeoutMs,
        maxAttempts: config.oms.maxAttempts,
        logger: config.logger,
        feeSchedules: config.fees,
      });
      const simulator = new PaperOrderSimulator(engine, this.portfolio, {
        slippageBps: config.oms.slippageBps,
        fees: config.fees,
        logger: config.logger,
      });
      engine.setCommandSender(simulator);
      this.omsEngine = engine;
    }
  }

  execute(intent: ExecutionIntent): ExecutionOutcome {
    if (!this.omsEngine) {
      return this.atomicExecute(intent);
    }
    return this.omsExecute(intent);
  }

  /** Advance the OMS state machine: timeouts, cancels, leg-risk detection. */
  tick(nowMs: number, views: InstrumentView[]): void {
    this.omsEngine?.tick(nowMs, views);
  }

  /** OMS counters for reporting. */
  omsStats(): OmsStats {
    return (
      this.omsEngine?.getStats() ?? {
        attemptsSubmitted: 0,
        legRiskEvents: 0,
        stuckOrders: 0,
      }
    );
  }

  private atomicExecute(intent: ExecutionIntent): ExecutionOutcome {
    const firstReason = this.validate(intent.legs[0]) ?? this.validate(intent.legs[1]);
    if (firstReason !== null) {
      return { status: 'skipped', signalId: intent.signalId, reason: firstReason };
    }

    const scaled = this.scaleIntent(intent);
    const fills: PaperFill[] = [];

    for (const leg of scaled.legs) {
      const schedule = this.config.fees[leg.venue];
      const notionalUsd = leg.priceUsd.mul(leg.sizeCoin);
      const feeUsd = computeFeeUsd(schedule, {
        role: 'taker',
        priceUsd: leg.priceUsd,
        sizeCoin: leg.sizeCoin,
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
        sizeCoin: leg.sizeCoin,
        notionalUsd,
        feeUsd,
      };
      fills.push(fill);
      this.portfolio.applyFill(fill);
    }

    return { status: 'executed', result: this.buildResult(intent, fills) };
  }

  private omsExecute(intent: ExecutionIntent): ExecutionOutcome {
    const firstReason = this.validate(intent.legs[0]) ?? this.validate(intent.legs[1]);
    if (firstReason !== null) {
      return { status: 'skipped', signalId: intent.signalId, reason: firstReason };
    }

    const scaled = this.scaleIntent(intent);
    const nowMs = intent.tsMs;
    const attempt = this.omsEngine!.submit(scaled, nowMs);

    if (attempt.status === 'filled') {
      return { status: 'executed', result: this.buildResult(intent, attempt.fills) };
    }

    if (attempt.status === 'partially_filled') {
      return {
        status: 'skipped',
        signalId: intent.signalId,
        reason: `oms partially filled: ${this.legSummary(attempt)}`,
      };
    }

    if (
      attempt.status === 'cancelled' ||
      attempt.status === 'rejected' ||
      attempt.status === 'expired'
    ) {
      const reason = this.terminalReason(attempt) ?? attempt.status;
      return {
        status: 'skipped',
        signalId: intent.signalId,
        reason: `oms ${attempt.status}: ${reason}`,
      };
    }

    return {
      status: 'skipped',
      signalId: intent.signalId,
      reason: `oms incomplete: ${attempt.status}`,
    };
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

  private scaleIntent(intent: ExecutionIntent): ExecutionIntent {
    let scale = dec(1);
    for (const leg of intent.legs) {
      const fullNotionalUsd = leg.priceUsd.mul(leg.sizeCoin);
      if (fullNotionalUsd.gt(this.config.maxNotionalUsd)) {
        const legScale = this.config.maxNotionalUsd.div(fullNotionalUsd);
        if (legScale.lt(scale)) scale = legScale;
      }
    }
    if (scale.eq(1)) return intent;

    const [buy, sell] = intent.legs;
    return {
      ...intent,
      legs: [this.scaleLeg(buy, scale), this.scaleLeg(sell, scale)],
    };
  }

  private scaleLeg(leg: ExecutionLeg, scale: Decimal): ExecutionLeg {
    return {
      ...leg,
      sizeCoin: leg.sizeCoin.mul(scale),
    };
  }

  private buildResult(intent: ExecutionIntent, fills: PaperFill[]): ExecutionResult {
    let grossEdgeUsd = dec(0);
    let feesUsd = dec(0);
    for (const fill of fills) {
      grossEdgeUsd =
        fill.side === 'sell'
          ? grossEdgeUsd.add(fill.notionalUsd)
          : grossEdgeUsd.sub(fill.notionalUsd);
      feesUsd = feesUsd.add(fill.feeUsd);
    }
    return {
      signalId: intent.signalId,
      signalKind: intent.signalKind,
      fills,
      grossEdgeUsd,
      feesUsd,
      netEdgeUsd: grossEdgeUsd.sub(feesUsd),
    };
  }

  private terminalReason(attempt: ReturnType<OmsEngine['submit']>): string | undefined {
    for (const leg of attempt.legs) {
      const last = leg.history[leg.history.length - 1];
      if (last && (last.event === 'reject' || last.event === 'cancel' || last.event === 'expire')) {
        return last.note ?? last.event;
      }
    }
    return undefined;
  }

  private legSummary(attempt: ReturnType<OmsEngine['submit']>): string {
    return attempt.legs.map((l) => `${l.venue}:${l.side}=${l.status}`).join(', ');
  }
}
