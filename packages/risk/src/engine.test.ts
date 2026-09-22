import { describe, expect, it } from 'vitest';
import { dec, type Side, type Underlying, type Venue } from '@optarb/core';
import { DEFAULT_FEE_SCHEDULES, type ExecutionIntent, type ExecutionLeg } from '@optarb/execution';
import type { RiskConfig } from './config.js';
import { RiskEngine, riskStateFromSnapshot, type KillSwitchProvider } from './engine.js';
import type { RiskState } from './types.js';

const BASE_CONFIG: RiskConfig = {
  RISK_MAX_NOTIONAL_PER_TRADE_USD: dec('10000'),
  RISK_MAX_NOTIONAL_PER_VENUE_USD: dec('50000'),
  RISK_MAX_NOTIONAL_GLOBAL_USD: dec('200000'),
  RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: dec('100000'),
  RISK_MAX_DAILY_LOSS_USD: dec('5000'),
  RISK_MAX_DAILY_DRAWDOWN_USD: dec('7500'),
  RISK_MAX_QUOTE_AGE_MS: 2_000,
  RISK_MIN_EDGE_AFTER_FEES_BPS: dec('5'),
  RISK_MAX_INDEX_DIVERGENCE_BPS: dec('30'),
  RISK_MAX_LEG_SKEW_MS: 500,
  RISK_KILL_SWITCH: false,
  RISK_MAX_DELTA_PER_UNDERLYING: undefined,
  RISK_MAX_VEGA_PER_UNDERLYING_USD: undefined,
  RISK_MAX_GAMMA_PER_UNDERLYING_USD: undefined,
  RISK_MIN_MARGIN_HEADROOM_USD: undefined,
  RISK_MAX_POLYMARKET_SETTLEMENT_USD: undefined,
  RISK_AUTO_KILL_HEARTBEAT_IDLE_MS: 60_000,
  RISK_AUTO_KILL_SEQUENCE_GAPS: 3,
  RISK_AUTO_KILL_SEQUENCE_WINDOW_MS: 60_000,
  RISK_AUTO_KILL_REJECT_COUNT: 5,
  RISK_AUTO_KILL_REJECT_WINDOW_MS: 60_000,
};

function leg(
  venue: Venue,
  side: Side,
  priceUsd: string,
  sizeCoin: string,
  opts?: {
    viewKey?: string;
    underlying?: Underlying;
    indexUsd?: string | null;
    quoteRecvMs?: number;
  },
): ExecutionLeg {
  return {
    venue,
    instrumentId: `${venue}:BTC-OPT`,
    viewKey: opts?.viewKey ?? 'BTC:12345:50000:call',
    underlying: opts?.underlying ?? 'BTC',
    side,
    priceUsd: dec(priceUsd),
    sizeCoin: dec(sizeCoin),
    indexPriceUsd:
      opts?.indexUsd === undefined
        ? dec('64000')
        : opts.indexUsd === null
          ? null
          : dec(opts.indexUsd),
    quoteRecvMs: opts?.quoteRecvMs,
  };
}

function makeIntent(
  legs: [ExecutionLeg, ExecutionLeg],
  signalKind = 'cross-venue',
  tsMs = 1_000,
): ExecutionIntent {
  return { signalId: 'test:1', signalKind, legs, tsMs };
}

function emptyState(): RiskState {
  return {
    positions: [],
    perVenue: [],
    perUnderlying: [],
    grossNotionalUsd: dec(0),
    dailyRealizedPnlUsd: dec(0),
    dailyNetPnlUsd: dec(0),
  };
}

function stateWith(args: {
  grossNotionalUsd?: string;
  perVenue?: Array<{ key: Venue; notionalUsd: string }>;
  perUnderlying?: Array<{ key: Underlying; notionalUsd: string }>;
  dailyRealizedPnlUsd?: string;
  dailyNetPnlUsd?: string;
}): RiskState {
  return {
    positions: [],
    perVenue: args.perVenue?.map((v) => ({ key: v.key, notionalUsd: dec(v.notionalUsd) })) ?? [],
    perUnderlying:
      args.perUnderlying?.map((u) => ({ key: u.key, notionalUsd: dec(u.notionalUsd) })) ?? [],
    grossNotionalUsd: dec(args.grossNotionalUsd ?? '0'),
    dailyRealizedPnlUsd: dec(args.dailyRealizedPnlUsd ?? '0'),
    dailyNetPnlUsd: dec(args.dailyNetPnlUsd ?? args.dailyRealizedPnlUsd ?? '0'),
  };
}

describe('RiskEngine', () => {
  it('allows a valid cross-venue intent', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('okx', 'buy', '1000', '1'),
      leg('deribit', 'sell', '1100', '1'),
    ]);
    const result = await engine.check(intent, emptyState(), 1_500);
    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('denies when the kill switch is active', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_KILL_SWITCH: true },
      DEFAULT_FEE_SCHEDULES,
    );
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('kill-switch');
  });

  it('denies when the kill switch callback returns true', async () => {
    const killSwitch: KillSwitchProvider = () => true;
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES, killSwitch);
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('kill-switch');
  });

  it('denies when the kill switch callback returns a resolving true', async () => {
    const killSwitch: KillSwitchProvider = () => Promise.resolve(true);
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES, killSwitch);
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('kill-switch');
  });

  it('denies stale per-leg quotes', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('okx', 'buy', '1000', '1', { quoteRecvMs: 0 }),
      leg('deribit', 'sell', '1100', '1', { quoteRecvMs: 0 }),
    ]);
    const result = await engine.check(intent, emptyState(), 3_000);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('stale quote'))).toBe(true);
  });

  it('falls back to intent.tsMs when per-leg quoteRecvMs is absent', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent(
      [leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')],
      'cross-venue',
      500,
    );
    expect((await engine.check(intent, emptyState(), 2_499)).allowed).toBe(true);
    expect((await engine.check(intent, emptyState(), 2_501)).allowed).toBe(false);
  });

  it('denies non-positive price', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '0', '1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('non-positive price'))).toBe(true);
  });

  it('denies non-positive size', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '-1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('non-positive size'))).toBe(true);
  });

  it('denies when a leg exceeds the per-trade notional limit', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_NOTIONAL_PER_TRADE_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '2000', '1'), leg('deribit', 'sell', '2100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('per-trade notional'))).toBe(true);
  });

  it('denies when a venue notional limit is breached', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const state = stateWith({ perVenue: [{ key: 'okx', notionalUsd: '49000' }] });
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '2000', '1'), leg('deribit', 'sell', '2100', '1')]),
      state,
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('venue okx notional'))).toBe(true);
  });

  it('denies when the global notional limit is breached', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_NOTIONAL_GLOBAL_USD: dec('5000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '3000', '1'), leg('deribit', 'sell', '3100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('global notional'))).toBe(true);
  });

  it('denies when the per-underlying exposure limit is breached', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const state = stateWith({ perUnderlying: [{ key: 'BTC', notionalUsd: '99000' }] });
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '2000', '1'), leg('deribit', 'sell', '2100', '1')]),
      state,
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('underlying BTC exposure'))).toBe(true);
  });

  it('denies when the daily realized loss exceeds the limit', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const state = stateWith({ dailyRealizedPnlUsd: '-6000' });
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      state,
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('daily realized loss'))).toBe(true);
  });

  it('does not deny on daily realized profit', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const state = stateWith({ dailyRealizedPnlUsd: '6000' });
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      state,
      1_500,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows cross-venue intents with sufficient edge after fees', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    // Binary: buy YES at 0.48, sell YES at 0.52 on Polymarket-like tight spread.
    // Gross = 40, fees ~ 35, net ~ 5 on 480 buy notional => ~104 bps > 5 bps.
    const result = await engine.check(
      makeIntent([
        leg('polymarket', 'buy', '0.48', '1000', { indexUsd: null }),
        leg('polymarket', 'sell', '0.52', '1000', { indexUsd: null }),
      ]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(true);
  });

  it('denies cross-venue intents when fees eat the edge', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    // Binary: 10 bps gross edge is smaller than taker fees.
    const result = await engine.check(
      makeIntent([
        leg('polymarket', 'buy', '0.495', '1000', { indexUsd: null }),
        leg('polymarket', 'sell', '0.500', '1000', { indexUsd: null }),
      ]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('net edge after fees'))).toBe(true);
  });

  it('denies non-cross-venue, non-parity intents (fail-closed, digital-vs-vanilla is observational only)', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent(
        [leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1001', '1')],
        'digital-vs-vanilla',
      ),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes('unknown signal kind'))).toBe(true);
  });

  it('denies when a fee schedule is missing for a leg venue (fail-closed)', async () => {
    const engine = new RiskEngine(BASE_CONFIG, {
      ...DEFAULT_FEE_SCHEDULES,
      okx: undefined as never,
    });
    const result = await engine.check(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('missing fee schedule'))).toBe(true);
  });

  it('applies edge-after-fees even when the two legs do not share a view', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent([
        leg('okx', 'buy', '1000', '1', { viewKey: 'BTC:12345:50000:call' }),
        leg('deribit', 'sell', '1100', '1', { viewKey: 'BTC:12345:50000:put' }),
      ]),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(true);
  });

  it('denies when the two legs quotes are skewed beyond the limit', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('okx', 'buy', '1000', '1', { quoteRecvMs: 1_000 }),
      leg('deribit', 'sell', '1100', '1', { quoteRecvMs: 1_600 }),
    ]);
    const result = await engine.check(intent, emptyState(), 1_700);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('leg quote skew'))).toBe(true);
  });

  it('allows legs quoted within the skew limit', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('okx', 'buy', '1000', '1', { quoteRecvMs: 1_000 }),
      leg('deribit', 'sell', '1100', '1', { quoteRecvMs: 1_400 }),
    ]);
    const result = await engine.check(intent, emptyState(), 1_500);
    expect(result.allowed).toBe(true);
  });

  it('denies when the two venues index prices diverge beyond the limit', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('okx', 'buy', '1000', '1', { indexUsd: '64000' }),
      leg('deribit', 'sell', '1100', '1', { indexUsd: '64500' }),
    ]);
    const result = await engine.check(intent, emptyState(), 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('index divergence'))).toBe(true);
  });

  it('skips the index-divergence guard when a leg has no index price', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const intent = makeIntent([
      leg('polymarket', 'buy', '0.48', '1000', { indexUsd: null }),
      leg('polymarket', 'sell', '0.52', '1000', { indexUsd: null }),
    ]);
    const result = await engine.check(intent, emptyState(), 1_500);
    expect(result.allowed).toBe(true);
  });

  it('returns multiple reasons when several limits are breached', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_NOTIONAL_PER_TRADE_USD: dec('500') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state = stateWith({
      perVenue: [{ key: 'okx', notionalUsd: '60000' }],
      dailyRealizedPnlUsd: '-7000',
    });
    const result = await engine.check(
      makeIntent([
        leg('okx', 'buy', '1000', '1', { quoteRecvMs: 0 }),
        leg('deribit', 'sell', '1100', '1', { quoteRecvMs: 0 }),
      ]),
      state,
      5_000,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('denies yes-no-parity buy-both intents with negative net edge after fees', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent(
        [
          leg('polymarket', 'buy', '0.495', '1000', { indexUsd: null }),
          leg('polymarket', 'buy', '0.500', '1000', { indexUsd: null }),
        ],
        'yes-no-parity',
      ),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('net edge after fees'))).toBe(true);
  });

  it('allows yes-no-parity buy-both intents with positive net edge after fees', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent(
        [
          leg('polymarket', 'buy', '0.40', '1000', { indexUsd: null }),
          leg('polymarket', 'buy', '0.40', '1000', { indexUsd: null }),
        ],
        'yes-no-parity',
      ),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows yes-no-parity sell-both intents with positive net edge after fees', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent(
        [
          leg('polymarket', 'sell', '0.60', '1000', { indexUsd: null }),
          leg('polymarket', 'sell', '0.60', '1000', { indexUsd: null }),
        ],
        'yes-no-parity',
      ),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(true);
  });

  it('denies an intent with an unrecognised signal kind (fail-closed)', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const result = await engine.check(
      makeIntent(
        [leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')],
        'mystery-signal',
      ),
      emptyState(),
      1_500,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes('unknown signal kind'))).toBe(true);
  });

  it('denies an intent with only one leg', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const malformed = {
      signalId: 'test:1',
      signalKind: 'cross-venue',
      legs: [leg('okx', 'buy', '1000', '1')],
      tsMs: 1_000,
    } as unknown as ExecutionIntent;
    const result = await engine.check(malformed, emptyState(), 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unsupported intent shape'))).toBe(true);
  });

  it('denies an intent with three or more legs', async () => {
    const engine = new RiskEngine(BASE_CONFIG, DEFAULT_FEE_SCHEDULES);
    const malformed = {
      signalId: 'test:1',
      signalKind: 'cross-venue',
      legs: [
        leg('okx', 'buy', '1000', '1'),
        leg('deribit', 'sell', '1100', '1'),
        leg('bybit', 'sell', '1100', '1'),
      ],
      tsMs: 1_000,
    } as unknown as ExecutionIntent;
    const result = await engine.check(malformed, emptyState(), 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unsupported intent shape'))).toBe(true);
  });
});

describe('RiskEngine greeks limits', () => {
  const validIntent = () =>
    makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]);

  it('denies when |delta| is over the cap', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_DELTA_PER_UNDERLYING: dec('5') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = {
      ...emptyState(),
      greeksPerUnderlying: [
        { underlying: 'BTC', delta: dec('7'), vegaUsd: dec(0), gammaUsd: dec(0) },
      ],
    };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('|delta|'))).toBe(true);
  });

  it('denies when |vega| is over the cap', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_VEGA_PER_UNDERLYING_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = {
      ...emptyState(),
      greeksPerUnderlying: [
        { underlying: 'BTC', delta: dec(0), vegaUsd: dec('-1500'), gammaUsd: dec(0) },
      ],
    };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('|vega|'))).toBe(true);
  });

  it('denies when |gamma| is over the cap', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_GAMMA_PER_UNDERLYING_USD: dec('2000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = {
      ...emptyState(),
      greeksPerUnderlying: [
        { underlying: 'BTC', delta: dec(0), vegaUsd: dec(0), gammaUsd: dec('2500') },
      ],
    };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('|gamma|'))).toBe(true);
  });

  it('allows when greeks are inside the caps', async () => {
    const engine = new RiskEngine(
      {
        ...BASE_CONFIG,
        RISK_MAX_DELTA_PER_UNDERLYING: dec('5'),
        RISK_MAX_VEGA_PER_UNDERLYING_USD: dec('1000'),
        RISK_MAX_GAMMA_PER_UNDERLYING_USD: dec('2000'),
      },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = {
      ...emptyState(),
      greeksPerUnderlying: [
        { underlying: 'BTC', delta: dec('2'), vegaUsd: dec('500'), gammaUsd: dec('100') },
      ],
    };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(true);
  });

  it('skips greeks checks when the state carries no greeks data', async () => {
    const engine = new RiskEngine(
      {
        ...BASE_CONFIG,
        RISK_MAX_DELTA_PER_UNDERLYING: dec('0.0001'),
        RISK_MAX_VEGA_PER_UNDERLYING_USD: dec('0.0001'),
        RISK_MAX_GAMMA_PER_UNDERLYING_USD: dec('0.0001'),
      },
      DEFAULT_FEE_SCHEDULES,
    );
    const result = await engine.check(validIntent(), emptyState(), 1_500);
    expect(result.allowed).toBe(true);
  });
});

describe('RiskEngine margin and settlement limits', () => {
  const validIntent = () =>
    makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]);

  it('denies when margin headroom is below the minimum', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MIN_MARGIN_HEADROOM_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = { ...emptyState(), marginHeadroomUsd: dec('250') };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('margin headroom'))).toBe(true);
  });

  it('allows when margin headroom covers the minimum', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MIN_MARGIN_HEADROOM_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = { ...emptyState(), marginHeadroomUsd: dec('5000') };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(true);
  });

  it('denies when the new intent would breach the Polymarket settlement cap', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_POLYMARKET_SETTLEMENT_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const intent = makeIntent(
      [
        leg('polymarket', 'buy', '0.40', '1000', { indexUsd: null }),
        leg('polymarket', 'buy', '0.40', '1000', { indexUsd: null }),
      ],
      'yes-no-parity',
    );
    const state: RiskState = { ...emptyState(), polymarketSettlementExposureUsd: dec('300') };
    const result = await engine.check(intent, state, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('settlement exposure'))).toBe(true);
  });

  it('ignores non-Polymarket legs for the settlement cap', async () => {
    const engine = new RiskEngine(
      { ...BASE_CONFIG, RISK_MAX_POLYMARKET_SETTLEMENT_USD: dec('1000') },
      DEFAULT_FEE_SCHEDULES,
    );
    const state: RiskState = { ...emptyState(), polymarketSettlementExposureUsd: dec('900') };
    const result = await engine.check(validIntent(), state, 1_500);
    expect(result.allowed).toBe(true);
  });
});

describe('riskStateFromSnapshot', () => {
  it('maps portfolio snapshot fields into risk state', () => {
    const snapshot = {
      positions: [
        {
          venue: 'okx' as Venue,
          instrumentId: 'okx:BTC-OPT',
          viewKey: 'BTC:12345:50000:call',
          underlying: 'BTC' as Underlying,
          qty: dec('1'),
          avgEntryUsd: dec('1000'),
          markUsd: dec('1100'),
          notionalUsd: dec('1100'),
          unrealizedPnlUsd: dec('100'),
          realizedPnlUsd: dec('50'),
          feesPaidUsd: dec('10'),
        },
      ],
      perVenue: [{ key: 'okx', notionalUsd: dec('1100'), pnlUsd: dec('140') }],
      perUnderlying: [{ key: 'BTC', notionalUsd: dec('1100'), pnlUsd: dec('140') }],
      openPositions: 1,
      grossNotionalUsd: dec('1100'),
      realizedPnlUsd: dec('50'),
      unrealizedPnlUsd: dec('100'),
      feesPaidUsd: dec('10'),
      netPnlUsd: dec('140'),
    };
    const state = riskStateFromSnapshot(snapshot, dec('25'), dec('115'));
    expect(state.grossNotionalUsd.toString()).toBe('1100');
    expect(state.dailyRealizedPnlUsd.toString()).toBe('25');
    expect(state.dailyNetPnlUsd.toString()).toBe('115');
    expect(state.perVenue[0]!.notionalUsd.toString()).toBe('1100');
    expect(state.positions[0]!.qty.toString()).toBe('1');
  });
});
