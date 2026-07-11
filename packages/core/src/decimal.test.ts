import { describe, expect, it } from 'vitest';
import { dec, Decimal } from './decimal.js';

describe('decimal', () => {
  it('avoids float artifacts', () => {
    expect(dec('0.1').plus('0.2').toString()).toBe('0.3');
    expect(dec(0.1).plus(0.2).toString()).not.toBe('0.30000000000000004');
  });

  it('accepts Decimal / string / number inputs', () => {
    expect(dec(new Decimal(5)).toNumber()).toBe(5);
    expect(dec('70000').toNumber()).toBe(70000);
    expect(dec(0.0125).toString()).toBe('0.0125');
  });
});
