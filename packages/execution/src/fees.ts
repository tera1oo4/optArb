import { dec, type Decimal, type Venue } from '@optarb/core';

/**
 * Options fee model shared by Deribit / Bybit / OKX / Binance:
 *   feeUsd = min(feeRate × indexPriceUsd, premiumCapFraction × premiumUsd) × sizeCoin
 * (per-coin terms; sizeCoin = contracts × multiplier). Deribit documents this
 * as "MIN(0.0003 BTC, 0.125 × OptionPrice) × Amount"; the other three venues
 * use the same min() shape with different caps.
 *
 * Polymarket is different: since 2026-03-30 fee-enabled markets charge takers
 *   feeUsd = shares × feeRate × p × (1 − p)   (p = share price, 0–1)
 * with zero maker fees; crypto-category rate is 0.07 as of 2026-07-10 (eased
 * from 0.072; sports went 0.03 → 0.05). Geopolitics markets remain fee-free.
 *
 * Sources (checked 2026-07-11):
 * - Deribit fee page / docs: 0.03% of underlying index per contract, capped at
 *   12.5% of the option price; maker = taker.
 *   https://www.deribit.com/pages/information/fees
 * - Bybit help center (Options fee): taker 0.03% / maker 0.02% of index,
 *   capped at 12.5% of the option price.
 *   https://help.bybit.com (Options trading fees); formula cross-checked with
 *   the Bybit options margin docs worked example:
 *   (0.03% × index, 12.5% × option price) min × qty
 * - OKX fee schedule: options taker 0.03% / maker 0.02%, capped at 12.5% of
 *   premium. https://www.okx.com/fees
 * - Binance Options: transaction fee 0.03% of index price, capped at 10% of
 *   the option premium; maker = taker. https://www.binance.com/en/fee/futureFee
 * - Polymarket: category-based taker fee, crypto rate 0.07, makers pay 0 and
 *   receive rebates; fee formula C × rate × p(1−p), rounded to 5 dp.
 *   https://docs.polymarket.com / startpolymarket.com/learn/polymarket-fees
 *
 * These are base-tier (non-VIP) rates and ASSUMPTIONS for paper PnL — real
 * accounts may have different tiers. Override per venue via PAPER_FEE_* env
 * knobs in apps/trader.
 */

/** min(rate × index, cap × premium) × size — Deribit/Bybit/OKX/Binance shape. */
export interface OptionFeeSchedule {
  kind: 'option';
  /** Fraction of the index price per coin of notional (0.0003 = 0.03%) */
  takerFeeRate: Decimal;
  makerFeeRate: Decimal;
  /** Fee cap as a fraction of the premium (0.125 = 12.5%) */
  premiumCapFraction: Decimal;
}

/** Polymarket: fee = shares × rate × p(1−p); makers pay nothing. */
export interface BinaryFeeSchedule {
  kind: 'binary';
  takerFeeRate: Decimal;
  makerFeeRate: Decimal;
}

export type FeeSchedule = OptionFeeSchedule | BinaryFeeSchedule;
export type FeeSchedules = Record<Venue, FeeSchedule>;

export type OrderRole = 'maker' | 'taker';

export interface FeeContext {
  role: OrderRole;
  /** Fill price in USD per coin (share price 0–1 for binary) */
  priceUsd: Decimal;
  /** Coin notional (shares for binary) */
  sizeCoin: Decimal;
  /** Underlying index in USD; option model only, null → cap branch */
  indexPriceUsd: Decimal | null;
}

export const DEFAULT_FEE_SCHEDULES: FeeSchedules = {
  deribit: {
    kind: 'option',
    takerFeeRate: dec('0.0003'),
    makerFeeRate: dec('0.0003'),
    premiumCapFraction: dec('0.125'),
  },
  bybit: {
    kind: 'option',
    takerFeeRate: dec('0.0003'),
    makerFeeRate: dec('0.0002'),
    premiumCapFraction: dec('0.125'),
  },
  okx: {
    kind: 'option',
    takerFeeRate: dec('0.0003'),
    makerFeeRate: dec('0.0002'),
    premiumCapFraction: dec('0.125'),
  },
  binance: {
    kind: 'option',
    takerFeeRate: dec('0.0003'),
    makerFeeRate: dec('0.0003'),
    premiumCapFraction: dec('0.10'),
  },
  polymarket: {
    kind: 'binary',
    takerFeeRate: dec('0.07'),
    makerFeeRate: dec('0'),
  },
};

/** Per-venue string overrides (env-driven); undefined fields keep defaults. */
export interface FeeOverride {
  takerFeeRate?: string;
  makerFeeRate?: string;
  premiumCapFraction?: string;
}

export function resolveFeeSchedules(overrides: Partial<Record<Venue, FeeOverride>>): FeeSchedules {
  const out = {} as FeeSchedules;
  for (const venue of Object.keys(DEFAULT_FEE_SCHEDULES) as Venue[]) {
    const base = DEFAULT_FEE_SCHEDULES[venue];
    const o = overrides[venue];
    if (!o) {
      out[venue] = base;
      continue;
    }
    const takerFeeRate = o.takerFeeRate !== undefined ? dec(o.takerFeeRate) : base.takerFeeRate;
    const makerFeeRate = o.makerFeeRate !== undefined ? dec(o.makerFeeRate) : base.makerFeeRate;
    out[venue] =
      base.kind === 'option'
        ? {
            kind: 'option',
            takerFeeRate,
            makerFeeRate,
            premiumCapFraction:
              o.premiumCapFraction !== undefined
                ? dec(o.premiumCapFraction)
                : base.premiumCapFraction,
          }
        : { kind: 'binary', takerFeeRate, makerFeeRate };
  }
  return out;
}

/** Trading fee in USD for one executed leg. */
export function computeFeeUsd(schedule: FeeSchedule, ctx: FeeContext): Decimal {
  const rate = ctx.role === 'taker' ? schedule.takerFeeRate : schedule.makerFeeRate;
  if (schedule.kind === 'option') {
    const capPerCoin = schedule.premiumCapFraction.mul(ctx.priceUsd);
    // Missing index → conservative fallback to the premium-cap branch.
    const ratePerCoin = ctx.indexPriceUsd === null ? capPerCoin : rate.mul(ctx.indexPriceUsd);
    const perCoin = ratePerCoin.lte(capPerCoin) ? ratePerCoin : capPerCoin;
    return perCoin.mul(ctx.sizeCoin);
  }
  // binary: fee = shares × rate × p(1−p), p clamped to [0, 1]
  const p = ctx.priceUsd.lte(0) ? dec(0) : ctx.priceUsd.gte(1) ? dec(1) : ctx.priceUsd;
  return ctx.sizeCoin.mul(rate).mul(p).mul(dec(1).sub(p));
}
