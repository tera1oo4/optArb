import { describe, expect, it } from 'vitest';
import { decimalString } from './validators.js';

describe('decimalString', () => {
  it('accepts integer and decimal strings', () => {
    expect(decimalString.safeParse('10').success).toBe(true);
    expect(decimalString.safeParse('0.0015').success).toBe(true);
    expect(decimalString.safeParse('-3.14').success).toBe(true);
  });

  it('rejects non-finite and malformed values', () => {
    expect(decimalString.safeParse('NaN').success).toBe(false);
    expect(decimalString.safeParse('Infinity').success).toBe(false);
    expect(decimalString.safeParse('').success).toBe(false);
    expect(decimalString.safeParse('  ').success).toBe(false);
    expect(decimalString.safeParse('abc').success).toBe(false);
  });
});
