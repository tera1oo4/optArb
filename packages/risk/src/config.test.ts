import { describe, expect, it } from 'vitest';
import { Decimal } from '@optarb/core';
import { RiskConfigSchema } from './config.js';

describe('RiskConfigSchema', () => {
  it('parses empty env into Decimal money limits with defaults', () => {
    const cfg = RiskConfigSchema.parse({});
    expect(cfg.RISK_MAX_NOTIONAL_PER_TRADE_USD).toBeInstanceOf(Decimal);
    expect(cfg.RISK_MAX_NOTIONAL_PER_TRADE_USD.toString()).toBe('10000');
    expect(cfg.RISK_MIN_EDGE_AFTER_FEES_BPS.toString()).toBe('5');
    expect(cfg.RISK_MAX_QUOTE_AGE_MS).toBe(2_000);
    expect(cfg.RISK_KILL_SWITCH).toBe(false);
  });

  it('accepts numeric strings and numbers for money limits (ADR-0002)', () => {
    const cfg = RiskConfigSchema.parse({
      RISK_MAX_NOTIONAL_PER_TRADE_USD: '25000',
      RISK_MAX_DAILY_LOSS_USD: 3000,
    });
    expect(cfg.RISK_MAX_NOTIONAL_PER_TRADE_USD.toString()).toBe('25000');
    expect(cfg.RISK_MAX_DAILY_LOSS_USD.toString()).toBe('3000');
  });

  it('rejects non-numeric money limits', () => {
    expect(() => RiskConfigSchema.parse({ RISK_MAX_NOTIONAL_PER_TRADE_USD: 'lots' })).toThrow();
  });

  it('leaves optional greeks/margin/settlement caps unset by default', () => {
    const cfg = RiskConfigSchema.parse({});
    expect(cfg.RISK_MAX_DELTA_PER_UNDERLYING).toBeUndefined();
    expect(cfg.RISK_MAX_VEGA_PER_UNDERLYING_USD).toBeUndefined();
    expect(cfg.RISK_MAX_GAMMA_PER_UNDERLYING_USD).toBeUndefined();
    expect(cfg.RISK_MIN_MARGIN_HEADROOM_USD).toBeUndefined();
    expect(cfg.RISK_MAX_POLYMARKET_SETTLEMENT_USD).toBeUndefined();
  });

  it('parses optional caps when provided', () => {
    const cfg = RiskConfigSchema.parse({
      RISK_MAX_DELTA_PER_UNDERLYING: '5',
      RISK_MIN_MARGIN_HEADROOM_USD: '1000',
      RISK_MAX_POLYMARKET_SETTLEMENT_USD: 20000,
    });
    expect(cfg.RISK_MAX_DELTA_PER_UNDERLYING?.toString()).toBe('5');
    expect(cfg.RISK_MIN_MARGIN_HEADROOM_USD?.toString()).toBe('1000');
    expect(cfg.RISK_MAX_POLYMARKET_SETTLEMENT_USD?.toString()).toBe('20000');
  });

  it('parses auto kill-switch tripwires with defaults', () => {
    const cfg = RiskConfigSchema.parse({});
    expect(cfg.RISK_AUTO_KILL_HEARTBEAT_IDLE_MS).toBe(60_000);
    expect(cfg.RISK_AUTO_KILL_SEQUENCE_GAPS).toBe(3);
    expect(cfg.RISK_AUTO_KILL_REJECT_COUNT).toBe(5);
  });
});
