import { Decimal } from 'decimal.js';

/**
 * All money/price/quantity math goes through decimal.js (ADR-0002).
 * float `number` arithmetic on financial values is forbidden.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 30 });

export { Decimal };

export type DecimalInput = Decimal | string | number;

export function dec(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}
