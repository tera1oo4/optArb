import { dec, type Decimal, type Underlying } from '@optarb/core';

export interface ParsedPolymarketQuestion {
  /** BTC/ETH when the question names a supported underlying, else null */
  underlying: Underlying | null;
  /**
   * Strike in USD — only set for expiry-level "above $X" questions, which are
   * true digital calls. "reach $X" / "dip to $X" are touch markets with a
   * different payoff and intentionally yield null (no model price in M3).
   */
  strike: Decimal | null;
  /** true when underlying + strike are known and the payoff is an expiry digital */
  parseable: boolean;
}

const UNDERLYING_PATTERNS: { re: RegExp; underlying: Underlying }[] = [
  { re: /bitcoin|\bbtc\b/i, underlying: 'BTC' },
  { re: /ethereum|\beth\b/i, underlying: 'ETH' },
];

/** First dollar amount in the question: "$62,000" / "$1,200.50" → Decimal. */
const STRIKE_RE = /\$([0-9][0-9,]*(?:\.[0-9]+)?)/;

/**
 * Pragmatic question parser (M3): a single regex pass with graceful fallback.
 * Real formats seen on Gamma (2026-07):
 * - "Will the price of Bitcoin be above $62,000 on July 12?" → digital call
 * - "Will Bitcoin reach $65,000 in July?" / "dip to $1,200" → touch, skipped
 * - "Bitcoin Up or Down - July 11, 1:15PM-1:30PM ET" → no strike, skipped
 */
export function parsePolymarketQuestion(question: string): ParsedPolymarketQuestion {
  const underlying = UNDERLYING_PATTERNS.find((p) => p.re.test(question))?.underlying ?? null;

  // Only expiry-level comparisons are priceable as Black-76 digitals.
  const isExpiryDigital = /above/i.test(question);
  const m = STRIKE_RE.exec(question);
  const strike = isExpiryDigital && m?.[1] ? dec(m[1].replace(/,/g, '')) : null;

  return {
    underlying,
    strike,
    parseable: underlying !== null && strike !== null,
  };
}
