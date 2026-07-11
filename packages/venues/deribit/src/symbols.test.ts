import { describe, expect, it } from 'vitest';
import { parseInstrumentName } from './symbols.js';

describe('parseInstrumentName', () => {
  it('parses call options', () => {
    const p = parseInstrumentName('BTC-28JUN24-70000-C');
    expect(p.kind).toBe('option');
    expect(p.underlying).toBe('BTC');
    expect(p.optionType).toBe('call');
    expect(p.strike?.toNumber()).toBe(70000);
    expect(p.expiryMs).toBe(Date.UTC(2024, 5, 28, 8, 0, 0));
  });

  it('parses put options', () => {
    const p = parseInstrumentName('ETH-25DEC26-4000-P');
    expect(p.kind).toBe('option');
    expect(p.underlying).toBe('ETH');
    expect(p.optionType).toBe('put');
    expect(p.strike?.toNumber()).toBe(4000);
    expect(p.expiryMs).toBe(Date.UTC(2026, 11, 25, 8, 0, 0));
  });

  it('parses perpetuals and dated futures', () => {
    expect(parseInstrumentName('BTC-PERPETUAL').kind).toBe('perpetual');
    const f = parseInstrumentName('ETH-27SEP24');
    expect(f.kind).toBe('future');
    expect(f.strike).toBeNull();
    expect(f.expiryMs).toBe(Date.UTC(2024, 8, 27, 8, 0, 0));
  });

  it('rejects invalid names', () => {
    expect(() => parseInstrumentName('DOGE-28JUN24-1-C')).toThrow();
    expect(() => parseInstrumentName('BTC')).toThrow();
    expect(() => parseInstrumentName('BTC-28JUN24-70000-X')).toThrow();
  });
});
