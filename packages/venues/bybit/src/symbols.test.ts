import { describe, expect, it } from 'vitest';
import { parseBybitSymbol } from './symbols.js';

describe('parseBybitSymbol', () => {
  it('parses USDT-settled put', () => {
    const p = parseBybitSymbol('BTC-25JUN27-45000-P-USDT');
    expect(p.underlying).toBe('BTC');
    expect(p.optionType).toBe('put');
    expect(p.strike.toString()).toBe('45000');
    expect(p.settleSuffix).toBe('USDT');
    expect(p.expiryMs).toBe(Date.UTC(2027, 5, 25, 8, 0, 0, 0));
  });

  it('parses USDC-settled call', () => {
    const p = parseBybitSymbol('ETH-28MAR25-2200-C-USDC');
    expect(p.underlying).toBe('ETH');
    expect(p.optionType).toBe('call');
    expect(p.strike.toString()).toBe('2200');
    expect(p.settleSuffix).toBe('USDC');
    expect(p.expiryMs).toBe(Date.UTC(2025, 2, 28, 8, 0, 0, 0));
  });

  it('parses legacy symbol without settle suffix', () => {
    const p = parseBybitSymbol('BTC-31DEC26-100000-C');
    expect(p.settleSuffix).toBeNull();
    expect(p.expiryMs).toBe(Date.UTC(2026, 11, 31, 8, 0, 0, 0));
  });

  it('rejects malformed and unsupported symbols', () => {
    expect(() => parseBybitSymbol('BTC-USD-260712-56000-C')).toThrow();
    expect(() => parseBybitSymbol('SOL-25JUN27-100-C-USDT')).toThrow(/unsupported underlying/);
    expect(() => parseBybitSymbol('garbage')).toThrow();
  });
});
