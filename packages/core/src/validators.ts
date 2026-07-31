import { z } from 'zod';

/**
 * Accepts strings that parse to a finite number.
 *
 * NOTE: this is intentionally strict. Empty strings, whitespace-only strings,
 * `Infinity`, `-Infinity`, and `NaN` are rejected.
 */
export const decimalString = z.string().refine(
  (s) => {
    if (s.trim().length === 0) return false;
    const n = Number(s);
    return Number.isFinite(n);
  },
  { message: 'must be a decimal number string' },
);
