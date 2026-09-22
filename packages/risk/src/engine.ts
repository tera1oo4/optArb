import { dec, type Decimal, type Venue } from '@optarb/core';
import { computeFeeUsd, type FeeSchedules } from '@optarb/execution';
import type { ExecutionIntent, ExecutionLeg, PortfolioSnapshot } from '@optarb/execution';
import type { RiskConfig } from './config.js';
import type { RiskCheckResult, RiskExposure, RiskPosition, RiskState } from './types.js';

/**
 * Maps the paper portfolio snapshot into the read-only risk state.
 * dailyRealizedPnlUsd and dailyNetPnlUsd are provided separately because the
 * portfolio tracks cumulative PnL, while risk cares about the current
 * session/day.
 */
export function riskStateFromSnapshot(
  snapshot: PortfolioSnapshot,
  dailyRealizedPnlUsd: Decimal,
  dailyNetPnlUsd: Decimal,
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
    dailyNetPnlUsd,
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

  async check(
    intent: ExecutionIntent,
    state: RiskState,
    nowMs: number,
    killSwitchActive?: boolean,
  ): Promise<RiskCheckResult> {
    const reasons: string[] = [];

    if (killSwitchActive ?? (await this.isKillSwitchActive())) {
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

    if (
      state.dailyNetPnlUsd.lt(0) &&
      state.dailyNetPnlUsd.neg().gt(this.config.RISK_MAX_DAILY_DRAWDOWN_USD)
    ) {
      reasons.push(
        `daily mark-to-market drawdown ${state.dailyNetPnlUsd.toFixed(2)} USD exceeds ${this.config.RISK_MAX_DAILY_DRAWDOWN_USD}`,
      );
    }

    const edgeReason = this.checkIntentEdge(intent);
    if (edgeReason) reasons.push(edgeReason);

    const skewReason = this.checkLegSkew(intent);
    if (skewReason) reasons.push(skewReason);

    const indexReason = this.checkIndexDivergence(intent);
    if (indexReason) reasons.push(indexReason);

    for (const reason of this.checkGreeks(state)) reasons.push(reason);
    const marginReason = this.checkMarginHeadroom(state);
    if (marginReason) reasons.push(marginReason);
    const settlementReason = this.checkPolymarketSettlement(intent, state);
    if (settlementReason) reasons.push(settlementReason);

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

  /**
   * Reject a two-legged intent whose legs were quoted too far apart in time.
   * Each leg comes from a different venue feed; a large gap means one side is
   * stale relative to the other and the "edge" may already be gone.
   */
  private checkLegSkew(intent: ExecutionIntent): string | null {
    if (intent.legs.length !== 2) return null;
    const [a, b] = intent.legs;
    if (!a || !b || a.quoteRecvMs === undefined || b.quoteRecvMs === undefined) return null;
    const skewMs = Math.abs(a.quoteRecvMs - b.quoteRecvMs);
    if (skewMs > this.config.RISK_MAX_LEG_SKEW_MS) {
      return `leg quote skew ${skewMs}ms exceeds ${this.config.RISK_MAX_LEG_SKEW_MS}ms`;
    }
    return null;
  }

  /**
   * Reject a cross-venue intent where the two venues disagree on the underlying
   * index price by more than the allowed bps. Such a "spread" is an index-print
   * artifact, not a tradable option mispricing. Legs without an index price
   * (e.g. Polymarket) skip the check.
   */
  private checkIndexDivergence(intent: ExecutionIntent): string | null {
    if (intent.legs.length !== 2) return null;
    const [a, b] = intent.legs;
    if (!a || !b) return null;
    const ia = a.indexPriceUsd;
    const ib = b.indexPriceUsd;
    if (!ia || !ib || ia.lte(0) || ib.lte(0)) return null;
    const divergenceBps = ia.sub(ib).abs().div(ia).mul(10_000);
    if (divergenceBps.gt(this.config.RISK_MAX_INDEX_DIVERGENCE_BPS)) {
      return `index divergence ${divergenceBps.toFixed(2)} bps between ${a.venue}/${b.venue} exceeds ${this.config.RISK_MAX_INDEX_DIVERGENCE_BPS}`;
    }
    return null;
  }

  /**
   * Greeks exposure caps (ADR-0006). Enforced only for underlyings the state
   * reports greeks for; underlyings without greeks data skip the check so a
   * portfolio that does not track greeks yet is not blocked outright.
   * A new intent is denied while the book is already over the cap (fail-closed
   * on the existing exposure — the intent itself carries no greeks).
   */
  private checkGreeks(state: RiskState): string[] {
    const reasons: string[] = [];
    const greeks = state.greeksPerUnderlying;
    if (!greeks) return reasons;
    const { RISK_MAX_DELTA_PER_UNDERLYING: maxDelta } = this.config;
    const { RISK_MAX_VEGA_PER_UNDERLYING_USD: maxVega } = this.config;
    const { RISK_MAX_GAMMA_PER_UNDERLYING_USD: maxGamma } = this.config;
    for (const g of greeks) {
      if (maxDelta !== undefined && g.delta.abs().gt(maxDelta)) {
        reasons.push(
          `underlying ${g.underlying} |delta| ${g.delta.abs().toFixed(4)} exceeds ${maxDelta.toFixed(4)}`,
        );
      }
      if (maxVega !== undefined && g.vegaUsd.abs().gt(maxVega)) {
        reasons.push(
          `underlying ${g.underlying} |vega| ${g.vegaUsd.abs().toFixed(2)} USD exceeds ${maxVega.toFixed(2)}`,
        );
      }
      if (maxGamma !== undefined && g.gammaUsd.abs().gt(maxGamma)) {
        reasons.push(
          `underlying ${g.underlying} |gamma| ${g.gammaUsd.abs().toFixed(2)} USD exceeds ${maxGamma.toFixed(2)}`,
        );
      }
    }
    return reasons;
  }

  /**
   * Margin sufficiency pre-check (ADR-0006): deny new intents while the
   * reported free-margin headroom is below the configured minimum.
   * Skipped when the state carries no margin data.
   */
  private checkMarginHeadroom(state: RiskState): string | null {
    const min = this.config.RISK_MIN_MARGIN_HEADROOM_USD;
    if (min === undefined || state.marginHeadroomUsd === undefined) return null;
    if (state.marginHeadroomUsd.lt(min)) {
      return `margin headroom ${state.marginHeadroomUsd.toFixed(2)} USD < minimum ${min.toFixed(2)}`;
    }
    return null;
  }

  /**
   * Polymarket settlement-risk cap (ADR-0006): the amount locked in YES/NO
   * positions until binary settlement must stay bounded. Adds the new
   * intent's Polymarket-leg notional to the reported unsettled exposure.
   * Skipped when no cap is configured.
   */
  private checkPolymarketSettlement(intent: ExecutionIntent, state: RiskState): string | null {
    const max = this.config.RISK_MAX_POLYMARKET_SETTLEMENT_USD;
    if (max === undefined) return null;
    let newPolyNotional = dec(0);
    for (const leg of intent.legs) {
      if (leg.venue === 'polymarket') {
        newPolyNotional = newPolyNotional.add(leg.priceUsd.mul(leg.sizeCoin));
      }
    }
    const after = (state.polymarketSettlementExposureUsd ?? dec(0)).add(newPolyNotional);
    if (after.gt(max)) {
      return `polymarket settlement exposure ${after.toFixed(2)} USD exceeds ${max.toFixed(2)}`;
    }
    return null;
  }

  /**
   * Minimum-edge-after-fees gate. The payoff of a two-legged intent depends on
   * its shape, so the formula is selected by `signalKind`:
   *
   * - `cross-venue`: directional pair — edge = sell proceeds − buy cost − fees,
   *   measured against the capital put up on the buy leg.
   * - `yes-no-parity`: both legs are on the SAME side of a Polymarket YES/NO
   *   pair that pays exactly $1 per complete set. Buying both costs Σ ask and
   *   returns $1; selling both requires minting a complete set for $1 and
   *   returns Σ bid. Treating this as "sell − buy" (the directional formula)
   *   would compare the two tokens against each other and produce nonsense.
   *
   * An unrecognised shape is rejected — fail-closed. Skipping the check, as the
   * previous single-formula version did for same-side legs, let YES/NO-parity
   * intents reach execution with an unverified (possibly negative) net edge.
   */
  private checkIntentEdge(intent: ExecutionIntent): string | null {
    if (intent.legs.length !== 2) {
      return `unsupported intent shape: expected 2 legs, got ${intent.legs.length}`;
    }
    const [a, b] = intent.legs;
    if (!a || !b) return 'unsupported intent shape: missing leg';

    const feesUsd = this.takerFeesUsd(a, b);
    if (feesUsd === null) return `missing fee schedule for ${a.venue}/${b.venue}`;

    const edge =
      intent.signalKind === 'cross-venue'
        ? this.crossVenueEdge(a, b, feesUsd)
        : intent.signalKind === 'yes-no-parity'
          ? this.parityEdge(a, b, feesUsd)
          : { error: `unknown signal kind '${intent.signalKind}': edge cannot be verified` };

    if ('error' in edge) return edge.error;

    const netEdgeBps = edge.netEdgeUsd.div(edge.capitalUsd).mul(10_000);
    if (netEdgeBps.lt(this.config.RISK_MIN_EDGE_AFTER_FEES_BPS)) {
      return `net edge after fees ${netEdgeBps.toFixed(2)} bps < ${this.config.RISK_MIN_EDGE_AFTER_FEES_BPS}`;
    }
    return null;
  }

  /** Sum of taker fees on both legs; null when a venue has no fee schedule. */
  private takerFeesUsd(a: ExecutionLeg, b: ExecutionLeg): Decimal | null {
    const scheduleA = this.fees[a.venue];
    const scheduleB = this.fees[b.venue];
    if (!scheduleA || !scheduleB) return null;
    return computeFeeUsd(scheduleA, {
      role: 'taker',
      priceUsd: a.priceUsd,
      sizeCoin: a.sizeCoin,
      indexPriceUsd: a.indexPriceUsd,
    }).add(
      computeFeeUsd(scheduleB, {
        role: 'taker',
        priceUsd: b.priceUsd,
        sizeCoin: b.sizeCoin,
        indexPriceUsd: b.indexPriceUsd,
      }),
    );
  }

  private crossVenueEdge(
    a: ExecutionLeg,
    b: ExecutionLeg,
    feesUsd: Decimal,
  ): { netEdgeUsd: Decimal; capitalUsd: Decimal } | { error: string } {
    const buyLeg = a.side === 'buy' ? a : b.side === 'buy' ? b : null;
    const sellLeg = a.side === 'sell' ? a : b.side === 'sell' ? b : null;
    if (!buyLeg || !sellLeg) {
      return { error: 'cross-venue intent must have one buy leg and one sell leg' };
    }

    const buyNotional = buyLeg.priceUsd.mul(buyLeg.sizeCoin);
    if (buyNotional.lte(0)) return { error: 'cross-venue intent has non-positive buy notional' };
    const sellNotional = sellLeg.priceUsd.mul(sellLeg.sizeCoin);

    return {
      netEdgeUsd: sellNotional.sub(buyNotional).sub(feesUsd),
      capitalUsd: buyNotional,
    };
  }

  private parityEdge(
    a: ExecutionLeg,
    b: ExecutionLeg,
    feesUsd: Decimal,
  ): { netEdgeUsd: Decimal; capitalUsd: Decimal } | { error: string } {
    if (a.side !== b.side) {
      return { error: 'yes-no-parity intent must have both legs on the same side' };
    }
    // A complete YES+NO set pays $1, so the tradable set count is the smaller
    // of the two leg sizes — the surplus on the larger leg is naked exposure.
    const sets = a.sizeCoin.lte(b.sizeCoin) ? a.sizeCoin : b.sizeCoin;
    if (sets.lte(0)) return { error: 'yes-no-parity intent has non-positive size' };
    const sumNotional = a.priceUsd.mul(a.sizeCoin).add(b.priceUsd.mul(b.sizeCoin));

    if (a.side === 'buy') {
      // Pay Σ ask now, collect $1 per set at settlement.
      if (sumNotional.lte(0)) return { error: 'yes-no-parity intent has non-positive cost' };
      return { netEdgeUsd: sets.sub(sumNotional).sub(feesUsd), capitalUsd: sumNotional };
    }
    // Mint a complete set for $1 (USDC collateral), sell both sides for Σ bid.
    return { netEdgeUsd: sumNotional.sub(sets).sub(feesUsd), capitalUsd: sets };
  }
}
