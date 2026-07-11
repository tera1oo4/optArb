import { dec, type Decimal } from '@optarb/core';

/** 1/sqrt(2*pi), 34 significant digits (matches core Decimal precision). */
const INV_SQRT_2PI = dec('0.3989422804014326779399460599343819');

/* Abramowitz & Stegun 26.2.17 polynomial coefficients; |error| < 7.5e-8. */
const P = dec('0.2316419');
const B1 = dec('0.31938153');
const B2 = dec('-0.356563782');
const B3 = dec('1.781477937');
const B4 = dec('-1.821255978');
const B5 = dec('1.330274429');

/**
 * Standard normal cumulative distribution N(x), decimal.js only.
 * Rational approximation (A&S 26.2.17) — max abs error ~7.5e-8, which is
 * far below any tradable price increment. Symmetric: N(-x) = 1 - N(x).
 */
export function normalCdf(x: Decimal): Decimal {
  if (x.isZero()) return dec('0.5');
  const ax = x.abs();
  const t = dec(1).div(dec(1).add(P.mul(ax)));
  // Horner form of b1*t + b2*t^2 + ... + b5*t^5
  const poly = t.mul(B1.add(t.mul(B2.add(t.mul(B3.add(t.mul(B4.add(t.mul(B5)))))))));
  const pdf = INV_SQRT_2PI.mul(ax.mul(ax).div(2).neg().exp());
  const upper = dec(1).sub(pdf.mul(poly)); // N(|x|)
  return x.isNegative() ? dec(1).sub(upper) : upper;
}

/** Standard normal density phi(x). */
export function normalPdf(x: Decimal): Decimal {
  return INV_SQRT_2PI.mul(x.mul(x).div(2).neg().exp());
}
