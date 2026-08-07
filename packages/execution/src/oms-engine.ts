import { randomUUID } from 'node:crypto';
import { dec, type Decimal, type Logger } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import { computeFeeUsd, type FeeSchedules } from './fees.js';
import type {
  LegOrder,
  LegOrderHistoryEntry,
  LegRiskHandler,
  OmsEngineConfig,
  OmsStats,
  OrderAttempt,
  OrderCommandSender,
  OrderEvent,
  OrderStatus,
} from './oms-types.js';
import type { ExecutionIntent, ExecutionLeg, PaperFill } from './types.js';

function isTerminalLegStatus(status: OrderStatus): boolean {
  return (
    status === 'filled' || status === 'cancelled' || status === 'rejected' || status === 'expired'
  );
}

function isFillStatus(status: OrderStatus): boolean {
  return status === 'filled' || status === 'partially_filled';
}

function isTerminalFailure(status: OrderStatus): boolean {
  return status === 'cancelled' || status === 'rejected' || status === 'expired';
}

function deriveStatus(attempt: OrderAttempt): OrderStatus {
  const [a, b] = attempt.legs;
  const aFill = isFillStatus(a.status);
  const bFill = isFillStatus(b.status);
  const aTerminal = isTerminalLegStatus(a.status);
  const bTerminal = isTerminalLegStatus(b.status);

  if (aFill && bFill) return 'filled';
  if (aFill || bFill) return 'partially_filled';

  // No fills yet — terminal failures on either leg end the attempt.
  if (a.status === 'rejected' || b.status === 'rejected') return 'rejected';
  if (a.status === 'expired' || b.status === 'expired') return 'expired';
  if (a.status === 'cancelled' || b.status === 'cancelled') return 'cancelled';

  if (aTerminal || bTerminal) {
    // Should not reach here, but treat any unexpected terminal state as cancelled.
    return 'cancelled';
  }
  if (a.status === 'submitted' && b.status === 'submitted') return 'submitted';
  return 'pending';
}

/**
 * Two-legged order management state machine (M9). Still paper-only: it drives
 * a command sender but never calls a real venue order API.
 */
export class OmsEngine {
  private readonly attempts = new Map<string, OrderAttempt>();
  private readonly logger: Logger | undefined;
  private commandSender: OrderCommandSender | undefined;
  private readonly feeSchedules: FeeSchedules | undefined;
  private readonly legRiskHandler: LegRiskHandler | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly stats: OmsStats = {
    attemptsSubmitted: 0,
    legRiskEvents: 0,
    stuckOrders: 0,
  };

  constructor(config: OmsEngineConfig) {
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts;
    this.commandSender = config.commandSender;
    this.logger = config.logger;
    this.feeSchedules = config.feeSchedules;
    this.legRiskHandler = config.legRiskHandler;
  }

  /**
   * Create a new attempt and immediately issue submit commands for both legs.
   * If the command sender reports a terminal failure synchronously, the engine
   * retries up to `maxAttempts` using the same intent before returning the
   * final attempt.
   */
  submit(intent: ExecutionIntent, nowMs: number, views: InstrumentView[] = []): OrderAttempt {
    let attempt = this.createAttempt(intent, nowMs, 0, views);
    let attemptNumber = 1;
    while (isTerminalFailure(attempt.status) && attemptNumber < this.maxAttempts) {
      this.logRetry(attempt, attemptNumber);
      attemptNumber++;
      attempt = this.createAttempt(intent, nowMs, attemptNumber - 1, views);
    }
    return attempt;
  }

  /**
   * External order lifecycle callback. Used by the command sender (paper
   * simulator or future venue adapter) to drive state transitions.
   */
  onOrderEvent(attemptId: string, legIndex: number, event: OrderEvent, nowMs: number): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      this.logger?.warn('oms: order event for unknown attempt', {
        attemptId,
        legIndex,
        event: event.kind,
      });
      return;
    }
    const leg = attempt.legs[legIndex];
    if (!leg) {
      this.logger?.warn('oms: order event for unknown leg', { attemptId, legIndex });
      return;
    }

    this.applyEventToLeg(leg, event, nowMs);
    leg.history.push(this.historyEntry(event));
    this.recomputeStatus(attempt);

    if (event.kind === 'fill' || event.kind === 'partial_fill') {
      this.recordFill(attempt, legIndex, event);
    }
  }

  /**
   * Advance time: time out stuck legs, detect leg risk, and issue cancels.
   * `views` is passed to the command sender so paper fills can use the latest
   * top-of-book prices for any still-pending commands.
   */
  tick(nowMs: number, views: import('@optarb/marketdata').InstrumentView[]): void {
    let stuck = 0;
    for (const attempt of this.attempts.values()) {
      if (isTerminalLegStatus(attempt.status)) continue;
      const elapsed = nowMs - attempt.createdAt;
      if (elapsed > attempt.timeoutMs) {
        stuck++;
        for (let i = 0; i < 2; i++) {
          const leg = attempt.legs[i];
          if (!leg || isTerminalLegStatus(leg.status)) continue;
          if (this.commandSender) {
            this.commandSender.cancel(attempt, i, views, nowMs);
          } else {
            this.onOrderEvent(
              attempt.id,
              i,
              { kind: 'expire', tsMs: nowMs, reason: 'timeout' },
              nowMs,
            );
          }
        }
      }
      if (this.legRiskDetected(attempt, nowMs) && !attempt.legRiskAlerted) {
        attempt.legRiskAlerted = true;
        this.stats.legRiskEvents++;
        this.logLegRisk(attempt);
        this.canHedge(attempt, views, nowMs);
      }
    }
    this.stats.stuckOrders = stuck;

    // Drive the leg-risk policy (hedge/unwind work window) once per tick.
    this.legRiskHandler?.tick(views, nowMs);
  }

  /**
   * True when one leg has filled/partially filled and the other is either
   * terminal (cancelled/rejected/expired) or still not filled after the grace
   * period (`timeoutMs`).
   */
  legRiskDetected(attempt: OrderAttempt, nowMs: number): boolean {
    const filledLegs = attempt.legs.filter((l) => isFillStatus(l.status));
    if (filledLegs.length !== 1) return false;
    const other = attempt.legs.find((l) => !isFillStatus(l.status));
    if (!other) return false;
    if (isTerminalLegStatus(other.status)) return true;
    if (attempt.firstFillTsMs !== null && nowMs - attempt.firstFillTsMs > attempt.timeoutMs) {
      return true;
    }
    return false;
  }

  /**
   * Route a leg-risk attempt to the configured handler (hedge/unwind policy).
   * With no handler (paper mode) this just emits a structured log — the paper
   * portfolio already carries the one filled leg, so nothing else is needed.
   */
  canHedge(attempt: OrderAttempt, views: InstrumentView[], nowMs: number): void {
    if (this.legRiskHandler) {
      this.legRiskHandler.onLegRisk(attempt, views, nowMs);
      return;
    }
    this.logger?.info('oms.leg_risk (no handler)', {
      attemptId: attempt.id,
      signalId: attempt.signalId,
      status: attempt.status,
    });
  }

  getAttempt(id: string): OrderAttempt | undefined {
    return this.attempts.get(id);
  }

  getAttempts(): OrderAttempt[] {
    return [...this.attempts.values()];
  }

  getStats(): OmsStats {
    return { ...this.stats };
  }

  /** Allows wiring the command sender after construction to break the circular dependency with the simulator. */
  setCommandSender(sender: OrderCommandSender): void {
    this.commandSender = sender;
  }

  private createAttempt(
    intent: ExecutionIntent,
    nowMs: number,
    retries = 0,
    views: InstrumentView[] = [],
  ): OrderAttempt {
    const [buyLeg, sellLeg] = intent.legs;
    const id = randomUUID();
    const attempt: OrderAttempt = {
      id,
      signalId: intent.signalId,
      signalKind: intent.signalKind,
      createdAt: nowMs,
      status: 'pending',
      legs: [this.legOrderFrom(buyLeg), this.legOrderFrom(sellLeg)],
      timeoutMs: this.timeoutMs,
      fills: [],
      retries,
      firstFillTsMs: null,
      legRiskAlerted: false,
      retryHandled: false,
    };
    this.attempts.set(id, attempt);
    this.stats.attemptsSubmitted++;

    if (this.commandSender) {
      this.commandSender.submit(attempt, 0, views, nowMs);
      this.commandSender.submit(attempt, 1, views, nowMs);
    }
    this.recomputeStatus(attempt);
    return attempt;
  }

  private legOrderFrom(leg: ExecutionLeg): LegOrder {
    return {
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      viewKey: leg.viewKey,
      underlying: leg.underlying,
      side: leg.side,
      requestedPriceUsd: leg.priceUsd,
      requestedSizeCoin: leg.sizeCoin,
      filledSizeCoin: dec(0),
      avgFillPriceUsd: dec(0),
      status: 'pending',
      indexPriceUsd: leg.indexPriceUsd ?? null,
      history: [],
    };
  }

  private applyEventToLeg(leg: LegOrder, event: OrderEvent, nowMs: number): void {
    switch (event.kind) {
      case 'ack':
        if (leg.status === 'pending') leg.status = 'submitted';
        break;
      case 'fill':
      case 'partial_fill': {
        const fillSize = event.sizeCoin;
        const fillPrice = event.priceUsd;
        if (leg.filledSizeCoin.isZero()) {
          leg.avgFillPriceUsd = fillPrice;
        } else {
          leg.avgFillPriceUsd = leg.avgFillPriceUsd
            .mul(leg.filledSizeCoin)
            .add(fillPrice.mul(fillSize))
            .div(leg.filledSizeCoin.add(fillSize));
        }
        leg.filledSizeCoin = leg.filledSizeCoin.add(fillSize);
        leg.status = leg.filledSizeCoin.gte(leg.requestedSizeCoin) ? 'filled' : 'partially_filled';
        break;
      }
      case 'cancel':
        if (!isTerminalLegStatus(leg.status)) leg.status = 'cancelled';
        break;
      case 'reject':
        if (!isTerminalLegStatus(leg.status)) leg.status = 'rejected';
        break;
      case 'expire':
        if (!isTerminalLegStatus(leg.status)) leg.status = 'expired';
        break;
    }
    if (isFillStatus(leg.status)) {
      // Track first fill on the attempt for grace-period leg-risk detection.
      // The attempt itself is looked up by the caller via recomputeStatus.
    }
  }

  private historyEntry(event: OrderEvent): LegOrderHistoryEntry {
    let note: string | undefined;
    if (event.kind === 'fill' || event.kind === 'partial_fill') {
      note = `price=${event.priceUsd.toString()} size=${event.sizeCoin.toString()}`;
    } else if (event.kind === 'reject' || event.kind === 'cancel' || event.kind === 'expire') {
      note = event.reason;
    }
    return { event: event.kind, tsMs: event.tsMs, note };
  }

  private recomputeStatus(attempt: OrderAttempt): void {
    // firstFillTsMs is set from the actual fill event in recordFill.
    attempt.status = deriveStatus(attempt);
  }

  private recordFill(attempt: OrderAttempt, legIndex: number, event: OrderEvent): void {
    if (event.kind !== 'fill' && event.kind !== 'partial_fill') return;
    if (attempt.firstFillTsMs === null) {
      attempt.firstFillTsMs = event.tsMs;
    }
    const leg = attempt.legs[legIndex];
    if (!leg) return;
    const priceUsd = event.priceUsd;
    const sizeCoin = event.sizeCoin;
    const notionalUsd = priceUsd.mul(sizeCoin);
    const feeUsd =
      event.feeUsd ??
      (this.feeSchedules
        ? computeFeeUsd(this.feeSchedules[leg.venue], {
            role: 'taker',
            priceUsd,
            sizeCoin,
            indexPriceUsd: leg.indexPriceUsd,
          })
        : dec(0));
    const fill: PaperFill = {
      signalId: attempt.signalId,
      tsMs: event.tsMs,
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      viewKey: leg.viewKey,
      underlying: leg.underlying,
      side: leg.side,
      priceUsd,
      sizeCoin,
      notionalUsd,
      feeUsd,
    };
    attempt.fills.push(fill);
  }

  private logRetry(attempt: OrderAttempt, attemptNumber: number): void {
    this.logger?.warn('oms: retrying terminal attempt', {
      signalId: attempt.signalId,
      previousAttemptId: attempt.id,
      previousStatus: attempt.status,
      attemptNumber,
    });
  }

  private logLegRisk(attempt: OrderAttempt): void {
    this.logger?.warn('risk.leg_risk', {
      attemptId: attempt.id,
      signalId: attempt.signalId,
      signalKind: attempt.signalKind,
      status: attempt.status,
      legs: attempt.legs.map((l) => ({
        venue: l.venue,
        instrumentId: l.instrumentId,
        side: l.side,
        status: l.status,
        filledSizeCoin: l.filledSizeCoin.toString(),
        requestedSizeCoin: l.requestedSizeCoin.toString(),
      })),
    });
  }
}
