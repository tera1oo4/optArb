import { dec, type Decimal } from '@optarb/core';
import { isBinaryViewKey, type InstrumentView, type VenueQuote } from '@optarb/marketdata';
import { digitalCallPrice } from '@optarb/pricing';

/** Milliseconds per average year (365.25 d) for T = years-to-expiry. */
const MS_PER_YEAR = 31_557_600_000;

export interface DigitalVsVanillaSignal {
  kind: 'digital-vs-vanilla';
  /**
   * Model-based, NOT a locked arbitrage. The model price is a flat-vol Black-76
   * digital (DF·N(d2)) with no volatility-skew term, so `edge` carries a known
   * bias and this signal is observational only — never routed to execution.
   */
  model: true;
  /** Binary view key (`binary:BTC:...:call`) */
  key: string;
  /** Matching vanilla view key the model price was derived from */
  vanillaKey: string;
  /** Polymarket YES token instrument id */
  instrumentId: string;
  /** Vanilla instrument whose IV drove the model price */
  vanillaInstrumentId: string;
  vanillaVenue: string;
  /** YES mid price (0–1, USDC ≈ implied probability) */
  polymarketPrice: Decimal;
  /** Black-76 digital call price from the vanilla IV */
  modelPrice: Decimal;
  /** poly − model; > 0: YES is rich vs the vanilla-implied digital */
  edge: Decimal;
  forwardUsd: Decimal;
  vol: Decimal;
  tsMs: number;
}

export interface DigitalVsVanillaDetectorConfig {
  /**
   * Minimum |poly − model| in absolute probability points (e.g. '0.03' = 3¢
   * on a $1 payout). Absolute, not bps: digital prices live in [0, 1], so a
   * relative threshold would explode near zero.
   */
  minDeviation: Decimal;
  /** Continuously compounded risk-free rate for discounting */
  rate: Decimal;
  /** Quotes older than this (by recvMs) are ignored */
  maxQuoteAgeMs: number;
}

/**
 * Compares a Polymarket digital-call YES mid against the Black-76 digital call
 * implied by a vanilla option's mark IV at the same (underlying, expiry,
 * strike). Stateless — scans consolidated views on demand; works identically
 * live and in replay.
 *
 * Graceful skips: binary views without a parseable strike never exist (store),
 * views without a polymarket quote, vanilla views where every venue lacks
 * markIv (e.g. OKX public WS has null IV) or an index price, and expired
 * contracts (T <= 0).
 */
export class DigitalVsVanillaDetector {
  constructor(private readonly config: DigitalVsVanillaDetectorConfig) {}

  detect(views: InstrumentView[], nowMs: number): DigitalVsVanillaSignal[] {
    const vanillaByParts = new Map<string, InstrumentView>();
    for (const v of views) {
      if (!isBinaryViewKey(v.key)) vanillaByParts.set(partsKey(v), v);
    }

    const signals: DigitalVsVanillaSignal[] = [];
    for (const view of views) {
      // YES token = digital call; NO (digital put) is the parity detector's job.
      if (!isBinaryViewKey(view.key) || view.optionType !== 'call') continue;
      const poly = view.quotes.get('polymarket');
      if (!poly || !this.isFresh(poly, nowMs) || poly.bidUsd === null || poly.askUsd === null) {
        continue;
      }
      const vanilla = vanillaByParts.get(partsKey(view));
      if (!vanilla) continue;
      const source = this.ivSource(vanilla, nowMs);
      if (!source) continue;

      const timeToExpiryYears = dec(view.expiryMs - nowMs).div(MS_PER_YEAR);
      if (timeToExpiryYears.lte(0)) continue;

      // Synthetic forward from the spot index: F = S * exp(r * T).
      // This keeps the Black-76 model internally consistent instead of passing
      // the spot index directly as the forward while still discounting by r.
      const rateTimesT = this.config.rate.mul(timeToExpiryYears);
      const forwardUsd = source.indexPriceUsd!.mul(rateTimesT.exp());

      const modelPrice = digitalCallPrice({
        forward: forwardUsd,
        strike: view.strike,
        vol: source.markIv!,
        timeToExpiryYears,
        rate: this.config.rate,
      });
      const mid = poly.bidUsd.add(poly.askUsd).div(2);
      const edge = mid.sub(modelPrice);
      if (edge.abs().lt(this.config.minDeviation)) continue;

      signals.push({
        kind: 'digital-vs-vanilla',
        model: true,
        key: view.key,
        vanillaKey: vanilla.key,
        instrumentId: poly.instrumentId,
        vanillaInstrumentId: source.instrumentId,
        vanillaVenue: source.venue,
        polymarketPrice: mid,
        modelPrice,
        edge,
        forwardUsd,
        vol: source.markIv!,
        tsMs: Math.max(poly.tsMs, source.tsMs),
      });
    }
    return signals;
  }

  private isFresh(q: VenueQuote, nowMs: number): boolean {
    return q.recvMs > 0 && nowMs - q.recvMs <= this.config.maxQuoteAgeMs;
  }

  /** First fresh vanilla quote carrying both markIv and an index price. */
  private ivSource(view: InstrumentView, nowMs: number): VenueQuote | null {
    for (const q of view.quotes.values()) {
      if (q.venue === 'polymarket') continue;
      if (!this.isFresh(q, nowMs)) continue;
      if (q.markIv === null || q.indexPriceUsd === null) continue;
      return q;
    }
    return null;
  }
}

function partsKey(v: InstrumentView): string {
  return `${v.underlying}:${v.expiryMs}:${v.strike.toString()}`;
}
