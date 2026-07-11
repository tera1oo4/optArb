import { dec, type Decimal, type Instrument, type QuoteCurrency } from '@optarb/core';

/** Stable cross-venue key for the same option contract (ADR-0003). */
export function canonicalKey(parts: {
  underlying: string;
  expiryMs: number;
  strike: Decimal;
  optionType: string;
}): string {
  return `${parts.underlying}:${parts.expiryMs}:${parts.strike.toString()}:${parts.optionType}`;
}

export function canonicalKeyOf(inst: Instrument): string {
  if (inst.expiryMs === null || inst.strike === null || inst.optionType === null) {
    throw new Error(`marketdata: cannot build canonical key for non-option ${inst.id}`);
  }
  return canonicalKey({
    underlying: inst.underlying,
    expiryMs: inst.expiryMs,
    strike: inst.strike,
    optionType: inst.optionType,
  });
}

/**
 * Converts a venue-quoted option price to USD.
 * - Coin-quoted venues (Deribit: price in BTC/ETH) → price × indexPrice.
 * - USD/USDT/USDC → taken at par (v1 simplification; stables ≈ USD).
 */
export function priceToUsd(
  price: Decimal,
  quoteCurrency: QuoteCurrency,
  indexPriceUsd: Decimal | null,
): Decimal | null {
  if (quoteCurrency === 'USD' || quoteCurrency === 'USDT' || quoteCurrency === 'USDC') {
    return price;
  }
  if (indexPriceUsd === null) return null;
  return price.mul(indexPriceUsd);
}

/** Contract count → coin notional (size × multiplier). */
export function contractsToCoin(size: Decimal, contractMultiplier: Decimal): Decimal {
  return size.mul(contractMultiplier);
}

/** Coin notional → USD notional. */
export function coinToUsd(coin: Decimal, indexPriceUsd: Decimal | null): Decimal | null {
  return indexPriceUsd === null ? null : coin.mul(indexPriceUsd);
}

export { dec };
