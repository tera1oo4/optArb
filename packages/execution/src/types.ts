import type { Decimal, Side, Underlying, Venue } from '@optarb/core';

/**
 * Detector-agnostic execution request: exactly two legs (buy + sell).
 * Built by the app from any signal type (cross-venue today; digital-vs-vanilla
 * and YES/NO-parity later) plus the current consolidated view, so the
 * execution package never depends on @optarb/signals.
 */
export interface ExecutionLeg {
  venue: Venue;
  instrumentId: string;
  /** Consolidated view key (for logging / portfolio grouping) */
  viewKey: string;
  underlying: Underlying;
  side: Side;
  /** Fill price in USD per coin: top-of-book ask for buy, bid for sell */
  priceUsd: Decimal;
  /** Requested size in coin notional (shares for binary instruments) */
  sizeCoin: Decimal;
  /** Venue index price in USD; option fee model needs it, binary ignores it */
  indexPriceUsd: Decimal | null;
}

export interface ExecutionIntent {
  /** Unique id, carries the originating signal (e.g. `${kind}:${key}:${dir}:${tsMs}`) */
  signalId: string;
  signalKind: string;
  legs: [ExecutionLeg, ExecutionLeg];
  /** Signal timestamp; paper fills inherit it (deterministic under replay) */
  tsMs: number;
}

export interface PaperFill {
  signalId: string;
  tsMs: number;
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  side: Side;
  priceUsd: Decimal;
  sizeCoin: Decimal;
  /** priceUsd × sizeCoin (premium paid/received in USD) */
  notionalUsd: Decimal;
  /** Trading fee in USD; paper model always takes liquidity → taker fee */
  feeUsd: Decimal;
}

export interface ExecutionResult {
  signalId: string;
  signalKind: string;
  fills: PaperFill[];
  /** Sell proceeds − buy cost, before fees */
  grossEdgeUsd: Decimal;
  feesUsd: Decimal;
  netEdgeUsd: Decimal;
}

export type ExecutionOutcome =
  | { status: 'executed'; result: ExecutionResult }
  | { status: 'skipped'; signalId: string; reason: string };
