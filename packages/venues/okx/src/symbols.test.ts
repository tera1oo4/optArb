import { describe, expect, it } from 'vitest';
import { parseOkxSymbol } from './symbols.js';

describe('parseOkxSymbol', () => {
  it('parses a call instId', () => {
    const p = parseOkxSymbol('BTC-USD-260712-56000-C');
    expect(p.underlying).toBe('BTC');
    expect(p.optionType).toBe('call');
    expect(p.strike.toString()).toBe('56000');
    expect(p.expiryMs).toBe(Date.UTC(2026, 6, 12, 8, 0, 0, 0));
  });

  it('parses an ETH put instId', () => {
    const p = parseOkxSymbol('ETH-USD-251226-3400-P');
    expect(p.underlying).toBe('ETH');
    expect(p.optionType).toBe('put');
    expect(p.strike.toString()).toBe('3400');
    expect(p.expiryMs).toBe(Date.UTC(2025, 11, 26, 8, 0, 0, 0));
  });

  it('rejects malformed symbols', () => {
    expect(() => parseOkxSymbol('BTC-25JUN27-45000-P-USDT')).toThrow();
    expect(() => parseOkxSymbol('garbage')).toThrow();
  });
});
