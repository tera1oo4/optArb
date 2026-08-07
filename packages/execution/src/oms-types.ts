import type { Decimal, Logger, Side, Underlying, Venue } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import type { FeeSchedules } from './fees.js';
import type { PaperFill } from './types.js';

/**
 * Order statuses for a single leg or a whole two-legged attempt.
 * The attempt status is derived from its legs (see OmsEngine).
 */
export type OrderStatus =
  'pending' | 'submitted' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

/**
 * External order lifecycle events. In paper mode these are produced by the
 * PaperOrderSimulator; in a live future mode they would come from venue private
 * API callbacks.
 */
export type OrderEvent =
  | { kind: 'ack'; tsMs: number }
  | { kind: 'fill'; tsMs: number; priceUsd: Decimal; sizeCoin: Decimal; feeUsd?: Decimal }
  | { kind: 'partial_fill'; tsMs: number; priceUsd: Decimal; sizeCoin: Decimal; feeUsd?: Decimal }
  | { kind: 'cancel'; tsMs: number; reason?: string }
  | { kind: 'reject'; tsMs: number; reason: string }
  | { kind: 'expire'; tsMs: number; reason?: string };

export interface LegOrderHistoryEntry {
  event: OrderEvent['kind'];
  tsMs: number;
  note?: string;
}

/**
 * One leg of a two-legged arbitrage attempt. Kept deliberately close to the
 * venue order model so the same state machine can be reused for live trading.
 */
export interface LegOrder {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  side: Side;
  requestedPriceUsd: Decimal;
  requestedSizeCoin: Decimal;
  filledSizeCoin: Decimal;
  avgFillPriceUsd: Decimal;
  status: OrderStatus;
  indexPriceUsd: Decimal | null;
  history: LegOrderHistoryEntry[];
}

/**
 * A single two-legged arbitrage attempt. The status is always derived from the
 * legs; fills are accumulated as PaperFill records for PnL / audit reporting.
 */
export interface OrderAttempt {
  id: string;
  signalId: string;
  signalKind: string;
  createdAt: number;
  status: OrderStatus;
  legs: [LegOrder, LegOrder];
  timeoutMs: number;
  fills: PaperFill[];
  /** Number of previous attempts for the same signal (for retry limiting). */
  retries: number;
  /** Timestamp of the first fill/partial fill on any leg; null until then. */
  firstFillTsMs: number | null;
  /** Set once a leg-risk alert has been emitted for this attempt. */
  legRiskAlerted: boolean;
  /** Set once a terminal failure has been handled by the retry logic. */
  retryHandled: boolean;
}

export interface OrderCommandSender {
  submit(attempt: OrderAttempt, legIndex: number, views: InstrumentView[], nowMs: number): void;
  cancel(attempt: OrderAttempt, legIndex: number, views: InstrumentView[], nowMs: number): void;
}

/**
 * Pluggable policy invoked when a two-legged attempt enters leg-risk (one leg
 * filled, the other unable to complete). Implemented outside this paper-only
 * package (in `@optarb/live`) so the OMS engine never imports a venue order API.
 *
 * `onLegRisk` fires once when the attempt first crosses into leg-risk; `tick`
 * fires on every OMS tick so the handler can advance its own work window
 * (complete the second leg, unwind, or trip the kill switch).
 */
export interface LegRiskHandler {
  onLegRisk(attempt: OrderAttempt, views: InstrumentView[], nowMs: number): void;
  tick(views: InstrumentView[], nowMs: number): void;
}

export interface OmsStats {
  attemptsSubmitted: number;
  legRiskEvents: number;
  stuckOrders: number;
}

export interface OmsEngineConfig {
  timeoutMs: number;
  maxAttempts: number;
  commandSender?: OrderCommandSender;
  logger?: Logger;
  feeSchedules?: FeeSchedules;
  /** Optional leg-risk policy (hedge/unwind). Paper mode leaves it undefined. */
  legRiskHandler?: LegRiskHandler;
}
