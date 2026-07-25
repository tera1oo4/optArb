import { describe, expect, it } from 'vitest';
import { dec, type Side, type Underlying, type Venue } from '@optarb/core';
import { DEFAULT_FEE_SCHEDULES } from './fees.js';
import { PaperExecutor } from './paper-executor.js';
import type { ExecutionIntent, ExecutionLeg } from './types.js';

function leg(
  venue: Venue,
  side: Side,
  priceUsd: string,
  sizeCoin: string,
  indexUsd: string | null = '100000',
): ExecutionLeg {
  return {
    venue,
    instrumentId: `${venue}:BTC-OPT`,
    viewKey: 'BTC:12345:50000:call',
    underlying: 'BTC' as Underlying,
    side,
    priceUsd: dec(priceUsd),
    sizeCoin: dec(sizeCoin),
    indexPriceUsd: indexUsd === null ? null : dec(indexUsd),
  };
}

function makeIntent(legs: [ExecutionLeg, ExecutionLeg]): ExecutionIntent {
  return {
    signalId: 'test:1',
    signalKind: 'cross-venue',
    legs,
    tsMs: 1000,
  };
}

describe('PaperExecutor', () => {
  it('executes a two-legged cross-venue intent and computes net edge after fees', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
    );

    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;

    expect(outcome.result.fills).toHaveLength(2);
    expect(outcome.result.grossEdgeUsd.toFixed(2)).toBe('100.00'); // 1100 - 1000
    expect(outcome.result.feesUsd.gt(0)).toBe(true);
    expect(outcome.result.netEdgeUsd.toFixed(2)).toBe('40.00'); // 100 - 30 - 30 (taker both legs)
    expect(executor.portfolio.getPosition('okx', 'okx:BTC-OPT')?.qty.toString()).toBe('1');
    expect(executor.portfolio.getPosition('deribit', 'deribit:BTC-OPT')?.qty.toString()).toBe('-1');
  });

  it('scales each leg down when the requested notional exceeds the max', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('500'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
    );

    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;

    // common scale = min(500/1000, 500/1100) = 0.4545
    expect(outcome.result.fills[0]!.sizeCoin.toFixed(4)).toBe('0.4545');
    expect(outcome.result.fills[1]!.sizeCoin.toFixed(4)).toBe('0.4545');
    expect(outcome.result.fills[0]!.notionalUsd.toFixed(2)).toBe('454.55');
    expect(outcome.result.grossEdgeUsd.toFixed(2)).toBe('45.45');
  });

  it('skips when a leg has a non-positive price', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '0', '1'), leg('deribit', 'sell', '1100', '1')]),
    );
    expect(outcome.status).toBe('skipped');
  });

  it('skips when a leg has a non-positive size', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '0'), leg('deribit', 'sell', '1100', '1')]),
    );
    expect(outcome.status).toBe('skipped');
  });

  it('assigns taker role and per-leg fees in fill records', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    const outcome = executor.execute(
      makeIntent([
        leg('bybit', 'buy', '200', '1', '100000'),
        leg('bybit', 'sell', '220', '1', '100000'),
      ]),
    );

    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    expect(outcome.result.fills[0]!.feeUsd.gt(0)).toBe(true);
    expect(outcome.result.fills[1]!.feeUsd.gt(0)).toBe(true);
  });
});
