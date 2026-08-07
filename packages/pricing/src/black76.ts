import { dec, Decimal, type OptionType } from '@optarb/core';
import { normalCdf } from './normal.js';

export interface Black76Params {
  /** Forward price of the underlying, USD */
  forward: Decimal;
  /** Strike, USD */
  strike: Decimal;
  /** Annualized volatility as fraction (0.55 = 55%) */
  vol: Decimal;
  /** Time to expiry in years (fraction allowed); <= 0 means "at expiry" */
  timeToExpiryYears: Decimal;
  /** Continuously compounded risk-free rate as fraction (0.05 = 5%) */
  rate: Decimal;
  type: OptionType;
}

export type DigitalParams = Omit<Black76Params, 'type'>;

/** exp(-rate * t) — t <= 0 collapses to 1. */
export function discountFactor(rate: Decimal, timeToExpiryYears: Decimal): Decimal {
  if (timeToExpiryYears.lte(0)) return dec(1);
  return rate.mul(timeToExpiryYears).neg().exp();
}

/** Black-76 d1/d2; null when the formula degenerates (t <= 0 or vol <= 0). */
export function black76D1D2(
  forward: Decimal,
  strike: Decimal,
  vol: Decimal,
  timeToExpiryYears: Decimal,
): { d1: Decimal; d2: Decimal } | null {
  if (timeToExpiryYears.lte(0) || vol.lte(0)) return null;
  const volSqrtT = vol.mul(timeToExpiryYears.sqrt());
  const d1 = forward.div(strike).ln().add(vol.mul(vol).div(2).mul(timeToExpiryYears)).div(volSqrtT);
  return { d1, d2: d1.sub(volSqrtT) };
}

/**
 * Black-76 European option price on a forward (ADR-0002: decimal.js only).
 * Degenerate cases:
 * - t <= 0 → intrinsic value, no discounting;
 * - vol <= 0 → deterministic payoff discounted at the risk-free rate.
 */
export function black76Price(p: Black76Params): Decimal {
  const df = discountFactor(p.rate, p.timeToExpiryYears);
  if (p.timeToExpiryYears.lte(0)) {
    return p.type === 'call'
      ? Decimal.max(p.forward.sub(p.strike), 0)
      : Decimal.max(p.strike.sub(p.forward), 0);
  }
  const d = black76D1D2(p.forward, p.strike, p.vol, p.timeToExpiryYears);
  if (d === null) {
    // Zero vol: the forward is certain — discount the sure payoff.
    return p.type === 'call'
      ? df.mul(Decimal.max(p.forward.sub(p.strike), 0))
      : df.mul(Decimal.max(p.strike.sub(p.forward), 0));
  }
  return p.type === 'call'
    ? df.mul(p.forward.mul(normalCdf(d.d1)).sub(p.strike.mul(normalCdf(d.d2))))
    : df.mul(p.strike.mul(normalCdf(d.d2.neg())).sub(p.forward.mul(normalCdf(d.d1.neg()))));
}

/**
 * Black-76 digital (binary) call price = DF * N(d2): the risk-neutral
 * probability of finishing above the strike, discounted. This is the model
 * price a Polymarket "BTC above $K at expiry" YES token is compared against.
 * Pays 1 iff forward > strike at expiry (ties pay 0).
 */
export function digitalCallPrice(p: DigitalParams): Decimal {
  const df = discountFactor(p.rate, p.timeToExpiryYears);
  const d = black76D1D2(p.forward, p.strike, p.vol, p.timeToExpiryYears);
  if (d === null) return p.forward.gt(p.strike) ? df : dec(0);
  return df.mul(normalCdf(d.d2));
}

/**
 * Black-76 digital put price = DF * N(-d2); pays 1 iff forward < strike. */
export function digitalPutPrice(p: DigitalParams): Decimal {
  const df = discountFactor(p.rate, p.timeToExpiryYears);
  const d = black76D1D2(p.forward, p.strike, p.vol, p.timeToExpiryYears);
  if (d === null) return p.forward.lt(p.strike) ? df : dec(0);
  return df.mul(normalCdf(d.d2.neg()));
}

/**
 * Spot delta of a Black-76 option — the hedge ratio against the underlying
 * (perp/future that tracks spot), in coin per 1 coin of option notional.
 *
 * For a forward F = S·e^{rT} the discount factor and the dF/dS = e^{rT} drift
 * cancel, so the spot delta collapses to the Black-Scholes delta: N(d1) for a
 * call, N(d1) − 1 for a put. Range: [0, 1] calls, [−1, 0] puts.
 *
 * Degenerate cases (t <= 0 or vol <= 0): the payoff is deterministic, so delta
 * is ±1 when in-the-money and 0 otherwise.
 */
export function black76Delta(p: Black76Params): Decimal {
  const d = black76D1D2(p.forward, p.strike, p.vol, p.timeToExpiryYears);
  if (d === null) {
    if (p.type === 'call') return p.forward.gt(p.strike) ? dec(1) : dec(0);
    return p.forward.lt(p.strike) ? dec(-1) : dec(0);
  }
  const nd1 = normalCdf(d.d1);
  return p.type === 'call' ? nd1 : nd1.sub(1);
}
