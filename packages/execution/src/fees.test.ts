import { describe, expect, it } from 'vitest';
import { dec } from '@optarb/core';
import { computeFeeUsd, DEFAULT_FEE_SCHEDULES, resolveFeeSchedules } from './fees.js';

describe('fee schedules', () => {
  it('Deribit uses rate×index branch when it is smaller than cap×premium', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.deribit, {
      role: 'taker',
      priceUsd: dec('1000'),
      sizeCoin: dec('2'),
      indexPriceUsd: dec('100000'),
    });
    // per coin: min(0.0003 * 100_000, 0.125 * 1000) = min(30, 125) = 30
    expect(fee.toFixed(2)).toBe('60.00');
  });

  it('Deribit uses cap×premium branch when premium is cheap', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.deribit, {
      role: 'taker',
      priceUsd: dec('100'),
      sizeCoin: dec('2'),
      indexPriceUsd: dec('100000'),
    });
    // per coin: min(30, 12.5) = 12.5
    expect(fee.toFixed(2)).toBe('25.00');
  });

  it('falls back to premium cap branch when index is missing', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.deribit, {
      role: 'taker',
      priceUsd: dec('200'),
      sizeCoin: dec('1'),
      indexPriceUsd: null,
    });
    expect(fee.toFixed(2)).toBe('25.00'); // 0.125 * 200
  });

  it('Binance applies 10% premium cap', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.binance, {
      role: 'taker',
      priceUsd: dec('100'),
      sizeCoin: dec('1'),
      indexPriceUsd: dec('100000'),
    });
    // rate branch would be 30, cap branch is 10
    expect(fee.toFixed(2)).toBe('10.00');
  });

  it('Bybit taker is 0.03% with 12.5% cap', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.bybit, {
      role: 'taker',
      priceUsd: dec('500'),
      sizeCoin: dec('1'),
      indexPriceUsd: dec('100000'),
    });
    // min(30, 62.5) = 30
    expect(fee.toFixed(2)).toBe('30.00');
  });

  it('OKX maker is cheaper than taker', () => {
    const ctx = {
      role: 'maker' as const,
      priceUsd: dec('1000'),
      sizeCoin: dec('1'),
      indexPriceUsd: dec('100000'),
    };
    expect(computeFeeUsd(DEFAULT_FEE_SCHEDULES.okx, { ...ctx, role: 'taker' }).toFixed(2)).toBe(
      '30.00',
    );
    expect(computeFeeUsd(DEFAULT_FEE_SCHEDULES.okx, { ...ctx, role: 'maker' }).toFixed(2)).toBe(
      '20.00',
    );
  });

  it('Polymarket taker fee uses p(1-p) shape', () => {
    const ctx = {
      role: 'taker' as const,
      priceUsd: dec('0.5'),
      sizeCoin: dec('100'),
      indexPriceUsd: null,
    };
    // 100 * 0.07 * 0.5 * 0.5 = 1.75
    expect(computeFeeUsd(DEFAULT_FEE_SCHEDULES.polymarket, ctx).toFixed(2)).toBe('1.75');
  });

  it('Polymarket maker fee is zero', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.polymarket, {
      role: 'maker',
      priceUsd: dec('0.5'),
      sizeCoin: dec('100'),
      indexPriceUsd: null,
    });
    expect(fee.toFixed(2)).toBe('0.00');
  });

  it('Polymarket fee is near zero at extreme prices', () => {
    const fee = computeFeeUsd(DEFAULT_FEE_SCHEDULES.polymarket, {
      role: 'taker',
      priceUsd: dec('0.99'),
      sizeCoin: dec('100'),
      indexPriceUsd: null,
    });
    // 100 * 0.07 * 0.99 * 0.01 = 0.0693
    expect(fee.toFixed(4)).toBe('0.0693');
  });

  it('resolveFeeSchedules applies overrides and leaves defaults unchanged', () => {
    const fees = resolveFeeSchedules({
      deribit: { takerFeeRate: '0.0005' },
      polymarket: { takerFeeRate: '0.05' },
    });
    expect(fees.deribit.takerFeeRate.toString()).toBe('0.0005');
    expect(fees.deribit.kind).toBe('option');
    if (fees.deribit.kind === 'option') {
      expect(fees.deribit.premiumCapFraction.toString()).toBe('0.125');
    }
    expect(fees.polymarket.takerFeeRate.toString()).toBe('0.05');
    expect(fees.bybit.takerFeeRate.toString()).toBe('0.0003');
  });
});
