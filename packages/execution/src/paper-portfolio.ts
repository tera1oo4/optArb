import { dec, type Decimal, type Underlying, type Venue } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import type { PaperFill } from './types.js';

export interface PaperPosition {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  /** Signed coin notional: positive = long, negative = short */
  qty: Decimal;
  /** Average entry price in USD per coin for the open quantity */
  avgEntryUsd: Decimal;
  /** Last fill price — mark-to-market fallback when no quote is available */
  lastFillPriceUsd: Decimal;
  /** Price PnL of closed quantity, EXCLUDING fees (fees tracked separately) */
  realizedPnlUsd: Decimal;
  feesPaidUsd: Decimal;
}

export interface PositionReport {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  underlying: Underlying;
  qty: Decimal;
  avgEntryUsd: Decimal;
  markUsd: Decimal;
  notionalUsd: Decimal;
  unrealizedPnlUsd: Decimal;
  realizedPnlUsd: Decimal;
  feesPaidUsd: Decimal;
}

export interface ExposureReport {
  key: string;
  notionalUsd: Decimal;
  pnlUsd: Decimal;
}

export interface PortfolioSnapshot {
  positions: PositionReport[];
  perVenue: ExposureReport[];
  perUnderlying: ExposureReport[];
  openPositions: number;
  /** Σ |qty| × mark across open positions */
  grossNotionalUsd: Decimal;
  realizedPnlUsd: Decimal;
  unrealizedPnlUsd: Decimal;
  feesPaidUsd: Decimal;
  /** realized + unrealized − fees */
  netPnlUsd: Decimal;
}

function posKey(venue: Venue, instrumentId: string): string {
  return `${venue}|${instrumentId}`;
}

/**
 * In-memory paper portfolio (ADR-0006). Average-cost accounting per
 * (venue, instrumentId); realized PnL excludes fees — fees are tracked
 * separately and subtracted only in the snapshot's netPnlUsd.
 *
 * Unrealized PnL is marked against the latest view mid (bid+ask)/2, falling
 * back to the venue mark price, then to the position's last fill price when
 * the quote is missing (documented: stale/missing marks do not crash reports).
 */
export class PaperPortfolio {
  private readonly positions = new Map<string, PaperPosition>();

  applyFill(fill: PaperFill): PaperPosition {
    const key = posKey(fill.venue, fill.instrumentId);
    let pos = this.positions.get(key);
    if (!pos) {
      pos = {
        venue: fill.venue,
        instrumentId: fill.instrumentId,
        viewKey: fill.viewKey,
        underlying: fill.underlying,
        qty: dec(0),
        avgEntryUsd: dec(0),
        lastFillPriceUsd: fill.priceUsd,
        realizedPnlUsd: dec(0),
        feesPaidUsd: dec(0),
      };
      this.positions.set(key, pos);
    }

    const signed = fill.side === 'buy' ? fill.sizeCoin : fill.sizeCoin.neg();
    const sameSign = (pos.qty.gt(0) && signed.gt(0)) || (pos.qty.lt(0) && signed.lt(0));
    if (pos.qty.isZero() || sameSign) {
      // Opening or increasing: weighted-average entry.
      const newQty = pos.qty.add(signed);
      pos.avgEntryUsd = pos.qty
        .abs()
        .mul(pos.avgEntryUsd)
        .add(fill.sizeCoin.mul(fill.priceUsd))
        .div(newQty.abs());
      pos.qty = newQty;
    } else {
      // Reducing or flipping: realize PnL on the closed part.
      const closed = fill.sizeCoin.lte(pos.qty.abs()) ? fill.sizeCoin : pos.qty.abs();
      const pnlPerCoin = pos.qty.gt(0)
        ? fill.priceUsd.sub(pos.avgEntryUsd)
        : pos.avgEntryUsd.sub(fill.priceUsd);
      pos.realizedPnlUsd = pos.realizedPnlUsd.add(closed.mul(pnlPerCoin));
      pos.qty = pos.qty.add(signed);
      if (pos.qty.isZero()) {
        pos.avgEntryUsd = dec(0);
      } else if (
        ((pos.qty.gt(0) && signed.gt(0)) || (pos.qty.lt(0) && signed.lt(0))) &&
        closed.lt(fill.sizeCoin)
      ) {
        // Flipped through zero: the remainder opens at the fill price.
        pos.avgEntryUsd = fill.priceUsd;
      }
    }
    pos.lastFillPriceUsd = fill.priceUsd;
    pos.feesPaidUsd = pos.feesPaidUsd.add(fill.feeUsd);
    return pos;
  }

  /** Mark map: instrumentId → best available USD mark (mid, then venue mark). */
  private marks(views: InstrumentView[]): Map<string, Decimal> {
    const out = new Map<string, Decimal>();
    for (const view of views) {
      for (const q of view.quotes.values()) {
        const mid = q.bidUsd !== null && q.askUsd !== null ? q.bidUsd.add(q.askUsd).div(2) : null;
        const mark = mid ?? q.markUsd;
        if (mark !== null) out.set(q.instrumentId, mark);
      }
    }
    return out;
  }

  snapshot(views: InstrumentView[]): PortfolioSnapshot {
    const marks = this.marks(views);
    const perVenue = new Map<string, ExposureReport>();
    const perUnderlying = new Map<string, ExposureReport>();
    const reports: PositionReport[] = [];
    let grossNotionalUsd = dec(0);
    let realizedPnlUsd = dec(0);
    let unrealizedPnlUsd = dec(0);
    let feesPaidUsd = dec(0);
    let openPositions = 0;

    for (const pos of this.positions.values()) {
      realizedPnlUsd = realizedPnlUsd.add(pos.realizedPnlUsd);
      feesPaidUsd = feesPaidUsd.add(pos.feesPaidUsd);

      // Fallback chain: view mid → venue mark → last fill price.
      const markUsd = marks.get(pos.instrumentId) ?? pos.lastFillPriceUsd;
      const notionalUsd = pos.qty.abs().mul(markUsd);
      const upnl = pos.qty.mul(markUsd.sub(pos.avgEntryUsd));
      unrealizedPnlUsd = unrealizedPnlUsd.add(upnl);

      reports.push({
        venue: pos.venue,
        instrumentId: pos.instrumentId,
        viewKey: pos.viewKey,
        underlying: pos.underlying,
        qty: pos.qty,
        avgEntryUsd: pos.avgEntryUsd,
        markUsd,
        notionalUsd,
        unrealizedPnlUsd: upnl,
        realizedPnlUsd: pos.realizedPnlUsd,
        feesPaidUsd: pos.feesPaidUsd,
      });

      if (!pos.qty.isZero()) {
        openPositions++;
        grossNotionalUsd = grossNotionalUsd.add(notionalUsd);
      }

      // Aggregate exposure/PnL attribution for ALL positions, including closed
      // ones, so realized PnL is not lost from per-venue/underlying breakdowns.
      for (const [map, key] of [
        [perVenue, pos.venue],
        [perUnderlying, pos.underlying],
      ] as const) {
        const agg = map.get(key) ?? { key, notionalUsd: dec(0), pnlUsd: dec(0) };
        agg.notionalUsd = agg.notionalUsd.add(notionalUsd);
        agg.pnlUsd = agg.pnlUsd.add(upnl.add(pos.realizedPnlUsd).sub(pos.feesPaidUsd));
        map.set(key, agg);
      }
    }

    return {
      positions: reports,
      perVenue: [...perVenue.values()],
      perUnderlying: [...perUnderlying.values()],
      openPositions,
      grossNotionalUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      feesPaidUsd,
      netPnlUsd: realizedPnlUsd.add(unrealizedPnlUsd).sub(feesPaidUsd),
    };
  }

  getPosition(venue: Venue, instrumentId: string): PaperPosition | undefined {
    const pos = this.positions.get(posKey(venue, instrumentId));
    return pos ? { ...pos } : undefined;
  }
}
