import { dec, type Decimal, type Venue } from '@optarb/core';
import { computeFeeUsd, type FeeSchedules } from '@optarb/execution';
import type { ExecutionIntent, ExecutionLeg, PortfolioSnapshot } from '@optarb/execution';
import type { RiskConfig } from './config.js';
import type { RiskCheckResult, RiskExposure, RiskPosition, RiskState } from './types.js';

/**
 * Maps the paper portfolio snapshot into the read-only risk state.
 * dailyRealizedPnlUsd is provided separately because the portfolio tracks
 * cumulative realized PnL, while risk cares about the current session/day.
 */
export function riskStateFromSnapshot(
  snapshot: PortfolioSnapshot,
  dailyRealizedPnlUsd: Decimal,
): RiskState {
  return {
    positions: snapshot.positions.map((p): RiskPosition => ({
      venue: p.venue,
      instrumentId: p.instrumentId,
      viewKey: p.viewKey,
      underlying: p.underlying,
      qty: p.qty,
      notionalUsd: p.notionalUsd,
    })),
    perVenue: snapshot.perVenue.map((v): RiskExposure => ({
      key: v.key,
      notionalUsd: v.notionalUsd,
    })),
    perUnderlying: snapshot.perUnderlying.map((u): RiskExposure => ({
      key: u.key,
      notionalUsd: u.notionalUsd,
    })),
    grossNotionalUsd: snapshot.grossNotionalUsd,
    dailyRealizedPnlUsd,
  };
}

export type KillSwitchProvider = () => boolean | Promise<boolean>;

/**
 * Pre-trade risk engine (ADR-0006). Stateless: all current exposure is passed
 * in via RiskState on every check, so the engine is trivially replayable.
 */
export class RiskEngine {
  constructor(
    private readonly config: RiskConfig,
    private readonly fees: FeeSchedules,
    private readonly killSwitch?: KillSwitchProvider,
  ) {}

  async check(intent: ExecutionIntent, state: RiskState, nowMs: number): Promise<RiskCheckResult> {
    const reasons: string[] = [];

    if (await this.isKillSwitchActive()) {
      return { allowed: false, reasons: ['kill-switch'] };
    }

    const perVenueDelta = new Map<Venue, Decimal>();
    const perUnderlyingDelta = new Map<string, Decimal>();
    let tradeNotionalSum = dec(0);

    for (const leg of intent.legs) {
      const quoteAgeMs = nowMs - (leg.quoteRecvMs ?? intent.tsMs);
      if (quoteAgeMs > this.config.RISK_MAX_QUOTE_AGE_MS) {
        reasons.push(`stale quote on ${leg.venue}:${leg.instrumentId} (${quoteAgeMs}ms)`);
      }

      if (!leg.priceUsd.isFinite() || leg.priceUsd.lte(0)) {
        reasons.push(`non-positive price on ${leg.venue}:${leg.instrumentId}`);
      }
      if (!leg.sizeCoin.isFinite() || leg.sizeCoin.lte(0)) {
        reasons.push(`non-positive size on ${leg.venue}:${leg.instrumentId}`);
      }

      const notional = leg.priceUsd.mul(leg.sizeCoin);
      tradeNotionalSum = tradeNotionalSum.add(notional);

      if (notional.gt(this.config.RISK_MAX_NOTIONAL_PER_TRADE_USD)) {
        reasons.push(
          `per-trade notional ${notional.toFixed(2)} USD on ${leg.venue}:${leg.instrumentId} exceeds ${this.config.RISK_MAX_NOTIONAL_PER_TRADE_USD}`,
        );
      }

      const absoluteDelta = notional;
      perVenueDelta.set(leg.venue, (perVenueDelta.get(leg.venue) ?? dec(0)).add(absoluteDelta));
      perUnderlyingDelta.set(
        leg.underlying,
        (perUnderlyingDelta.get(leg.underlying) ?? dec(0)).add(absoluteDelta),
      );
    }

    const newGlobalNotional = state.grossNotionalUsd.add(tradeNotionalSum);
    if (newGlobalNotional.gt(this.config.RISK_MAX_NOTIONAL_GLOBAL_USD)) {
      reasons.push(
        `global notional ${newGlobalNotional.toFixed(2)} USD exceeds ${this.config.RISK_MAX_NOTIONAL_GLOBAL_USD}`,
      );
    }

    for (const [venue, delta] of perVenueDelta) {
      const after = this.exposure(state.perVenue, venue).add(delta);
      if (after.gt(this.config.RISK_MAX_NOTIONAL_PER_VENUE_USD)) {
        reasons.push(
          `venue ${venue} notional ${after.toFixed(2)} USD exceeds ${this.config.RISK_MAX_NOTIONAL_PER_VENUE_USD}`,
        );
      }
    }

    for (const [underlying, delta] of perUnderlyingDelta) {
      const after = this.exposure(state.perUnderlying, underlying).add(delta);
      if (after.gt(this.config.RISK_MAX_EXPOSURE_PER_UNDERLYING_USD)) {
        reasons.push(
          `underlying ${underlying} exposure ${after.toFixed(2)} USD exceeds ${this.config.RISK_MAX_EXPOSURE_PER_UNDERLYING_USD}`,
        );
      }
    }

    if (
      state.dailyRealizedPnlUsd.lt(0) &&
      state.dailyRealizedPnlUsd.neg().gt(this.config.RISK_MAX_DAILY_LOSS_USD)
    ) {
      reasons.push(
        `daily realized loss ${state.dailyRealizedPnlUsd.toFixed(2)} USD exceeds ${this.config.RISK_MAX_DAILY_LOSS_USD}`,
      );
    }

    const edgeReason = this.checkTwoLeggedEdge(intent);
    if (edgeReason) reasons.push(edgeReason);

    return reasons.length === 0 ? { allowed: true, reasons: [] } : { allowed: false, reasons };
  }

  private async isKillSwitchActive(): Promise<boolean> {
    if (this.killSwitch) {
      const result = this.killSwitch();
      return await result;
    }
    return this.config.RISK_KILL_SWITCH;
  }

  private exposure(buckets: RiskExposure[], key: string): Decimal {
    return buckets.find((b) => b.key === key)?.notionalUsd ?? dec(0);
  }

  private checkTwoLeggedEdge(intent: ExecutionIntent): string | null {
    if (intent.legs.length !== 2) return null;
    const [a, b] = intent.legs;
    if (!a || !b) return null;

    const buyLeg = a.side === 'buy' ? a : b.side === 'buy' ? b : null;
    const sellLeg = a.side === 'sell' ? a : b.side === 'sell' ? b : null;
    if (!buyLeg || !sellLeg) return null;

    const buyFeeSchedule = this.fees[buyLeg.venue];
    const sellFeeSchedule = this.fees[sellLeg.venue];
    if (!buyFeeSchedule || !sellFeeSchedule) return null;

    const buyNotional = buyLeg.priceUsd.mul(buyLeg.sizeCoin);
    if (buyNotional.lte(0)) return null;

    const feeBuy = computeFeeUsd(buyFeeSchedule, {
      role: 'taker',
      priceUsd: buyLeg.priceUsd,
      sizeCoin: buyLeg.sizeCoin,
      indexPriceUsd: buyLeg.indexPriceUsd,
    });
    const feeSell = computeFeeUsd(sellFeeSchedule, {
      role: 'taker',
      priceUsd: sellLeg.priceUsd,
      sizeCoin: sellLeg.sizeCoin,
      indexPriceUsd: sellLeg.indexPriceUsd,
    });

    const sellNotional = sellLeg.priceUsd.mul(sellLeg.sizeCoin);
    const grossEdgeUsd = sellNotional.sub(buyNotional);
    const netEdgeUsd = grossEdgeUsd.sub(feeBuy).sub(feeSell);
    const netEdgeBps = netEdgeUsd.div(buyNotional).mul(10_000);

    if (netEdgeBps.lt(this.config.RISK_MIN_EDGE_AFTER_FEES_BPS)) {
      return `net edge after fees ${netEdgeBps.toFixed(2)} bps < ${this.config.RISK_MIN_EDGE_AFTER_FEES_BPS}`;
    }
    return null;
  }
}
