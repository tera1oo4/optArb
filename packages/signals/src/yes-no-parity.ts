import { dec, type Decimal } from '@optarb/core';
import { isBinaryViewKey, type InstrumentView, type VenueQuote } from '@optarb/marketdata';

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
  /** Guaranteed edge vs the certain $1 payout: sum − 1 (sell) or 1 − sum (buy) */
  edge: Decimal;
  tsMs: number;
}

export interface YesNoParityDetectorConfig {
  /**
   * Minimum guaranteed edge in USDC per $1 payout (e.g. '0.02' = 2¢), meant
   * to cover fees + spread. Absolute: payouts are $1 by construction.
   */
  threshold: Decimal;
  /** Quotes older than this (by recvMs) are ignored */
  maxQuoteAgeMs: number;
}

/**
 * YES/NO parity detector for Polymarket binary markets. One token of each side
 * pays exactly $1, so:
 * - YES_bid + NO_bid > 1 + threshold → sell both, lock in sum − 1 (risk-free
 *   modulo settlement/counterparty risk);
 * - YES_ask + NO_ask < 1 − threshold → buy both, lock in 1 − sum.
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
        if (edge.gt(this.config.threshold)) {
          signals.push(
            this.signal(marketKey, 'sell-both', yes, no, yes.bidUsd, no.bidUsd, sum, edge),
          );
        }
      }
      if (yes.askUsd !== null && no.askUsd !== null) {
        const sum = yes.askUsd.add(no.askUsd);
        const edge = dec(1).sub(sum);
        if (edge.gt(this.config.threshold)) {
          signals.push(
            this.signal(marketKey, 'buy-both', yes, no, yes.askUsd, no.askUsd, sum, edge),
          );
        }
      }
    }
    return signals;
  }

  private isFresh(q: VenueQuote, nowMs: number): boolean {
    return q.recvMs > 0 && nowMs - q.recvMs <= this.config.maxQuoteAgeMs;
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
      tsMs: Math.max(yes.tsMs, no.tsMs),
    };
  }
}

function partsKey(v: InstrumentView): string {
  return `${v.underlying}:${v.expiryMs}:${v.strike.toString()}`;
}
