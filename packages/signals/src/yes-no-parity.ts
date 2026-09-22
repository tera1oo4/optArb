import { dec, type Decimal } from '@optarb/core';
import { isBinaryViewKey, type InstrumentView, type VenueQuote } from '@optarb/marketdata';
import { computeFeeUsd, type FeeSchedules } from '@optarb/execution';

export type YesNoParityDirection = 'buy-both' | 'sell-both';

export interface YesNoParitySignal {
  kind: 'yes-no-parity';
  /** `${underlying}:${expiryMs}:${strike}` — shared parts of the YES/NO token pair */
  marketKey: string;
  direction: YesNoParityDirection;
  yesInstrumentId: string;
  noInstrumentId: string;
  /** YES ask (buy-both) or YES bid (sell-both) */
  yesPrice: Decimal;
  /** NO ask (buy-both) or NO bid (sell-both) */
  noPrice: Decimal;
  sum: Decimal;
  /** Guaranteed edge vs the certain $1 payout, before fees: sum − 1 (sell) or 1 − sum (buy) */
  edge: Decimal;
  /** Edge net of both legs' Polymarket taker fees; this is what is compared against `threshold` */
  edgeAfterFees: Decimal;
  /** Capital required to open both legs: shares × (yesPrice + noPrice) */
  sizeUsd: Decimal;
  tsMs: number;
}

export interface YesNoParityDetectorConfig {
  /**
   * Minimum guaranteed edge in USDC per $1 payout (e.g. '0.005' = 0.5¢),
   * applied to `edgeAfterFees` — i.e. this is a buffer ON TOP OF the
   * Polymarket taker fees already deducted from both legs, not a raw
   * pre-fee threshold.
   */
  threshold: Decimal;
  /** Quotes older than this (by recvMs) are ignored */
  maxQuoteAgeMs: number;
  /** Fee schedules; only the `polymarket` entry (binary fee shape) is used. */
  feeSchedules: FeeSchedules;
  /** Minimum capital required to open both legs, in USD */
  minSizeUsd: Decimal;
}

/**
 * YES/NO parity detector for Polymarket binary markets. One token of each side
 * pays exactly $1, so:
 * - YES_bid + NO_bid > 1 + threshold → sell both, lock in sum − 1 (risk-free
 *   modulo settlement/counterparty risk);
 * - YES_ask + NO_ask < 1 − threshold → buy both, lock in 1 − sum.
 *
 * Both legs are taker fills on Polymarket, so both legs' taker fees
 * (fee = shares × rate × p(1−p)) are subtracted from the raw edge before
 * comparing against `threshold`.
 *
 * The YES (digital call) and NO (digital put) tokens of one market share the
 * same canonical parts (underlying, expiryMs, strike) — that is how the pair
 * is linked; the connector also records `conditionId` in instrument metadata.
 * Stateless; scans consolidated binary views on demand.
 */
export class YesNoParityDetector {
  constructor(private readonly config: YesNoParityDetectorConfig) {}

  detect(views: InstrumentView[], nowMs: number): YesNoParitySignal[] {
    const yesByParts = new Map<string, VenueQuote>();
    const noByParts = new Map<string, VenueQuote>();
    for (const v of views) {
      if (!isBinaryViewKey(v.key)) continue;
      const q = v.quotes.get('polymarket');
      if (!q || !this.isFresh(q, nowMs)) continue;
      const key = partsKey(v);
      if (v.optionType === 'call') yesByParts.set(key, q);
      else if (v.optionType === 'put') noByParts.set(key, q);
    }

    const signals: YesNoParitySignal[] = [];
    for (const [marketKey, yes] of yesByParts) {
      const no = noByParts.get(marketKey);
      if (!no) continue;

      if (yes.bidUsd !== null && no.bidUsd !== null) {
        const sum = yes.bidUsd.add(no.bidUsd);
        const edge = sum.sub(1);
        const feesUsd = this.feeFractionPerShare(yes.bidUsd).add(
          this.feeFractionPerShare(no.bidUsd),
        );
        const edgeAfterFees = edge.sub(feesUsd);
        const sizeUsd = this.executableSizeUsd(yes, no, 'sell-both');
        if (
          edgeAfterFees.gt(this.config.threshold) &&
          sizeUsd !== null &&
          sizeUsd.gte(this.config.minSizeUsd)
        ) {
          signals.push(
            this.signal(
              marketKey,
              'sell-both',
              yes,
              no,
              yes.bidUsd,
              no.bidUsd,
              sum,
              edge,
              edgeAfterFees,
              sizeUsd,
            ),
          );
        }
      }
      if (yes.askUsd !== null && no.askUsd !== null) {
        const sum = yes.askUsd.add(no.askUsd);
        const edge = dec(1).sub(sum);
        const feesUsd = this.feeFractionPerShare(yes.askUsd).add(
          this.feeFractionPerShare(no.askUsd),
        );
        const edgeAfterFees = edge.sub(feesUsd);
        const sizeUsd = this.executableSizeUsd(yes, no, 'buy-both');
        if (
          edgeAfterFees.gt(this.config.threshold) &&
          sizeUsd !== null &&
          sizeUsd.gte(this.config.minSizeUsd)
        ) {
          signals.push(
            this.signal(
              marketKey,
              'buy-both',
              yes,
              no,
              yes.askUsd,
              no.askUsd,
              sum,
              edge,
              edgeAfterFees,
              sizeUsd,
            ),
          );
        }
      }
    }
    return signals;
  }

  private isFresh(q: VenueQuote, nowMs: number): boolean {
    return q.recvMs > 0 && nowMs - q.recvMs <= this.config.maxQuoteAgeMs;
  }

  /**
   * Polymarket taker fee is `shares × rate × p(1−p)`, which is linear in
   * shares — so the fee expressed as a fraction of $1 payout (independent of
   * trade size) is `rate × p(1−p)`, computed here via `computeFeeUsd` with a
   * unit share size.
   */
  private feeFractionPerShare(priceUsd: Decimal): Decimal {
    const schedule = this.config.feeSchedules.polymarket;
    return computeFeeUsd(schedule, {
      role: 'taker',
      priceUsd,
      sizeCoin: dec(1),
      indexPriceUsd: null,
    });
  }

  /**
   * Capital required to open both legs, in USD: min(YES shares, NO shares)
   * available at top-of-book, times (yesPrice + noPrice) — the actual dollar
   * outlay (buy-both) or dollar proceeds (sell-both) for that many pairs.
   * `bidSizeCoin`/`askSizeCoin` are in shares (Polymarket coin units).
   */
  private executableSizeUsd(
    yes: VenueQuote,
    no: VenueQuote,
    direction: YesNoParityDirection,
  ): Decimal | null {
    const yesSizeCoin = direction === 'buy-both' ? yes.askSizeCoin : yes.bidSizeCoin;
    const noSizeCoin = direction === 'buy-both' ? no.askSizeCoin : no.bidSizeCoin;
    const yesPrice = direction === 'buy-both' ? yes.askUsd : yes.bidUsd;
    const noPrice = direction === 'buy-both' ? no.askUsd : no.bidUsd;
    if (yesSizeCoin === null || noSizeCoin === null || yesPrice === null || noPrice === null) {
      return null;
    }
    const shares = yesSizeCoin.lte(noSizeCoin) ? yesSizeCoin : noSizeCoin;
    return shares.mul(yesPrice.add(noPrice));
  }

  private signal(
    marketKey: string,
    direction: YesNoParityDirection,
    yes: VenueQuote,
    no: VenueQuote,
    yesPrice: Decimal,
    noPrice: Decimal,
    sum: Decimal,
    edge: Decimal,
    edgeAfterFees: Decimal,
    sizeUsd: Decimal,
  ): YesNoParitySignal {
    return {
      kind: 'yes-no-parity',
      marketKey,
      direction,
      yesInstrumentId: yes.instrumentId,
      noInstrumentId: no.instrumentId,
      yesPrice,
      noPrice,
      sum,
      edge,
      edgeAfterFees,
      sizeUsd,
      tsMs: Math.max(yes.tsMs, no.tsMs),
    };
  }
}

function partsKey(v: InstrumentView): string {
  return `${v.underlying}:${v.expiryMs}:${v.strike.toString()}`;
}
