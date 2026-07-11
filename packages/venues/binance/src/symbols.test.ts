import { describe, expect, it } from 'vitest';
import { parseBinanceSymbol, toStreamSymbol } from './symbols.js';

describe('parseBinanceSymbol', () => {
  it('parses a call symbol', () => {
    const p = parseBinanceSymbol('BTC-260712-63500-C');
    expect(p.underlying).toBe('BTC');
    expect(p.optionType).toBe('call');
    expect(p.strike.toString()).toBe('63500');
    expect(p.expiryMs).toBe(Date.UTC(2026, 6, 12, 8, 0, 0, 0));
  });

  it('parses an ETH put symbol', () => {
    const p = parseBinanceSymbol('ETH-261225-3400-P');
    expect(p.underlying).toBe('ETH');
    expect(p.optionType).toBe('put');
    expect(p.strike.toString()).toBe('3400');
    expect(p.expiryMs).toBe(Date.UTC(2026, 11, 25, 8, 0, 0, 0));
  });

  it('rejects malformed symbols', () => {
    expect(() => parseBinanceSymbol('BTC-USD-260712-56000-C')).toThrow();
    expect(() => parseBinanceSymbol('garbage')).toThrow();
  });

  it('lowercases for stream names', () => {
    expect(toStreamSymbol('BTC-260712-63500-C')).toBe('btc-260712-63500-c');
  });
});
