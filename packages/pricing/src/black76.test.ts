import { describe, expect, it } from 'vitest';
import { dec, type Decimal } from '@optarb/core';
import {
  black76D1D2,
  black76Price,
  digitalCallPrice,
  digitalPutPrice,
  discountFactor,
  normalCdf,
} from './index.js';

/** Asserts |actual - expected| < eps using exact decimal comparisons. */
function expectClose(actual: Decimal, expected: string, eps: string): void {
  const diff = actual.sub(dec(expected)).abs();
  expect(
    diff.lt(dec(eps)),
    `expected ${actual.toString()} within ${eps} of ${expected} (diff ${diff.toString()})`,
  ).toBe(true);
}

describe('normalCdf', () => {
  it('is exactly 0.5 at zero', () => {
    expect(normalCdf(dec(0)).toString()).toBe('0.5');
  });

  it('matches standard normal table values (textbook)', () => {
    expectClose(normalCdf(dec('0.25')), '0.5987063256829237', '1e-7');
    expectClose(normalCdf(dec('1.96')), '0.9750021048517796', '1e-7');
    expectClose(normalCdf(dec('-0.5')), '0.30853753872598694', '1e-7');
    expectClose(normalCdf(dec('3.5')), '0.9997673709209645', '1e-7');
  });

  it('is symmetric: N(x) + N(-x) = 1', () => {
    const x = dec('1.2345');
    const sum = normalCdf(x).add(normalCdf(x.neg()));
    expectClose(sum, '1', '1e-15');
  });
});

describe('black76Price', () => {
  it('ATM forward: call = put = 7.5771 (F=K=100, vol 20%, T=1, r=5%)', () => {
    const base = {
      forward: dec('100'),
      strike: dec('100'),
      vol: dec('0.2'),
      timeToExpiryYears: dec('1'),
      rate: dec('0.05'),
    };
    expectClose(black76Price({ ...base, type: 'call' }), '7.57708214642728', '1e-4');
    expectClose(black76Price({ ...base, type: 'put' }), '7.57708214642728', '1e-4');
  });

  it('OTM call / ITM put (F=60, K=65, vol 25%, T=0.25, r=8%)', () => {
    const base = {
      forward: dec('60'),
      strike: dec('65'),
      vol: dec('0.25'),
      timeToExpiryYears: dec('0.25'),
      rate: dec('0.08'),
    };
    expectClose(black76Price({ ...base, type: 'call' }), '1.2067341047945923', '1e-4');
    expectClose(black76Price({ ...base, type: 'put' }), '6.107727471328364', '1e-4');
  });

  it('satisfies put-call parity: call - put = DF * (F - K)', () => {
    const base = {
      forward: dec('105'),
      strike: dec('100'),
      vol: dec('0.36'),
      timeToExpiryYears: dec('0.5'),
      rate: dec('0.1'),
    };
    const call = black76Price({ ...base, type: 'call' });
    const put = black76Price({ ...base, type: 'put' });
    expectClose(call, '12.432844508202189', '1e-4');
    const df = discountFactor(base.rate, base.timeToExpiryYears);
    const parity = df.mul(base.forward.sub(base.strike));
    expectClose(call.sub(put), parity.toString(), '1e-10');
  });

  it('returns intrinsic value at expiry (t <= 0), undiscounted', () => {
    const base = {
      forward: dec('105'),
      strike: dec('100'),
      vol: dec('0.3'),
      timeToExpiryYears: dec('0'),
      rate: dec('0.05'),
    };
    expect(black76Price({ ...base, type: 'call' }).toString()).toBe('5');
    expect(black76Price({ ...base, type: 'put' }).toString()).toBe('0');
    expect(black76Price({ ...base, timeToExpiryYears: dec('-0.1'), type: 'put' }).toString()).toBe(
      '0',
    );
  });

  it('zero vol discounts the deterministic payoff', () => {
    const base = {
      forward: dec('110'),
      strike: dec('100'),
      vol: dec('0'),
      timeToExpiryYears: dec('1'),
      rate: dec('0.05'),
    };
    const df = discountFactor(base.rate, base.timeToExpiryYears); // e^-0.05
    expectClose(black76Price({ ...base, type: 'call' }), df.mul(10).toString(), '1e-15');
    expect(black76Price({ ...base, type: 'put' }).toString()).toBe('0');
  });
});

describe('digital prices', () => {
  it('digital call = DF * N(d2), digital put = DF * N(-d2)', () => {
    const base = {
      forward: dec('100'),
      strike: dec('100'),
      vol: dec('0.2'),
      timeToExpiryYears: dec('1'),
      rate: dec('0.05'),
    };
    expectClose(digitalCallPrice(base), '0.43772930151822065', '1e-6');
    expectClose(digitalPutPrice(base), '0.5135001229824934', '1e-6');
    // Digital call + digital put = discount factor (pays $1 for sure).
    const df = discountFactor(base.rate, base.timeToExpiryYears);
    expectClose(digitalCallPrice(base).add(digitalPutPrice(base)), df.toString(), '1e-15');
  });

  it('digital call OTM (F=60, K=65, vol 25%, T=0.25, r=8%)', () => {
    expectClose(
      digitalCallPrice({
        forward: dec('60'),
        strike: dec('65'),
        vol: dec('0.25'),
        timeToExpiryYears: dec('0.25'),
        rate: dec('0.08'),
      }),
      '0.23630356669644922',
      '1e-6',
    );
  });

  it('at expiry pays 1 iff forward > strike (ties pay 0)', () => {
    const base = {
      strike: dec('100'),
      vol: dec('0.3'),
      timeToExpiryYears: dec('0'),
      rate: dec('0'),
    };
    expect(digitalCallPrice({ ...base, forward: dec('101') }).toString()).toBe('1');
    expect(digitalCallPrice({ ...base, forward: dec('100') }).toString()).toBe('0');
    expect(digitalCallPrice({ ...base, forward: dec('99') }).toString()).toBe('0');
    expect(digitalPutPrice({ ...base, forward: dec('99') }).toString()).toBe('1');
  });

  it('zero vol is a discounted step function', () => {
    const base = {
      strike: dec('100'),
      vol: dec('0'),
      timeToExpiryYears: dec('1'),
      rate: dec('0.05'),
    };
    const df = discountFactor(base.rate, base.timeToExpiryYears);
    expectClose(digitalCallPrice({ ...base, forward: dec('105') }), df.toString(), '1e-15');
    expect(digitalCallPrice({ ...base, forward: dec('95') }).toString()).toBe('0');
  });
});

describe('black76D1D2', () => {
  it('computes d1/d2 for the ATM case', () => {
    const d = black76D1D2(dec('100'), dec('100'), dec('0.2'), dec('1'))!;
    expectClose(d.d1, '0.1', '1e-15');
    expectClose(d.d2, '-0.1', '1e-15');
  });

  it('returns null for degenerate inputs', () => {
    expect(black76D1D2(dec('100'), dec('100'), dec('0.2'), dec('0'))).toBeNull();
    expect(black76D1D2(dec('100'), dec('100'), dec('0'), dec('1'))).toBeNull();
  });
});
