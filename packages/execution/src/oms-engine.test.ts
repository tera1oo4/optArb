import { describe, expect, it } from 'vitest';
import { dec, noopLogger, type Side, type Underlying, type Venue } from '@optarb/core';
import type { InstrumentView, VenueQuote } from '@optarb/marketdata';
import { DEFAULT_FEE_SCHEDULES } from './fees.js';
import { OmsEngine } from './oms-engine.js';
import { PaperExecutor } from './paper-executor.js';
import { PaperOrderSimulator } from './paper-order-simulator.js';
import { PaperPortfolio } from './paper-portfolio.js';
import type { OrderCommandSender, OrderEvent } from './oms-types.js';
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

function makeIntent(legs: [ExecutionLeg, ExecutionLeg], signalId = 'test:1'): ExecutionIntent {
  return {
    signalId,
    signalKind: 'cross-venue',
    legs,
    tsMs: 1000,
  };
}

function venueQuote(
  instrumentId: string,
  venue: Venue,
  bidUsd: string | null,
  askUsd: string | null,
): VenueQuote {
  return {
    venue,
    instrumentId,
    bidUsd: bidUsd === null ? null : dec(bidUsd),
    askUsd: askUsd === null ? null : dec(askUsd),
    bidSizeCoin: dec('1'),
    askSizeCoin: dec('1'),
    markUsd: dec('1500'),
    markIv: null,
    indexPriceUsd: dec('100000'),
    tsMs: 1000,
    recvMs: 1000,
  };
}

function viewFor(
  instrumentId: string,
  venue: Venue,
  bidUsd: string | null,
  askUsd: string | null,
): InstrumentView {
  return {
    key: 'BTC:12345:50000:call',
    underlying: 'BTC',
    expiryMs: 12345,
    strike: dec('50000'),
    optionType: 'call',
    quotes: new Map([[venue, venueQuote(instrumentId, venue, bidUsd, askUsd)]]),
  };
}

function viewForBoth(
  deribitInstrumentId: string,
  deribitBidAsk: [string | null, string | null],
  okxInstrumentId: string,
  okxBidAsk: [string | null, string | null],
): InstrumentView {
  return {
    key: 'BTC:12345:50000:call',
    underlying: 'BTC',
    expiryMs: 12345,
    strike: dec('50000'),
    optionType: 'call',
    quotes: new Map([
      ['deribit', venueQuote(deribitInstrumentId, 'deribit', deribitBidAsk[0], deribitBidAsk[1])],
      ['okx', venueQuote(okxInstrumentId, 'okx', okxBidAsk[0], okxBidAsk[1])],
    ]),
  };
}

class RejectAllSender implements OrderCommandSender {
  constructor(private readonly engine: OmsEngine) {}

  submit(attempt: { id: string }, legIndex: number, _views: InstrumentView[], nowMs: number): void {
    const event: OrderEvent = { kind: 'reject', tsMs: nowMs, reason: 'mock reject' };
    this.engine.onOrderEvent(attempt.id, legIndex, event, nowMs);
  }

  cancel(attempt: { id: string }, legIndex: number, _views: InstrumentView[], nowMs: number): void {
    const event: OrderEvent = { kind: 'cancel', tsMs: nowMs, reason: 'mock cancel' };
    this.engine.onOrderEvent(attempt.id, legIndex, event, nowMs);
  }
}

describe('OmsEngine', () => {
  it('submit creates an attempt in pending status with both legs pending', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const attempt = engine.submit(
      makeIntent([leg('deribit', 'buy', '1000', '1'), leg('okx', 'sell', '1100', '1')]),
      1000,
    );
    expect(attempt.status).toBe('pending');
    expect(attempt.legs[0]!.status).toBe('pending');
    expect(attempt.legs[1]!.status).toBe('pending');
    expect(engine.getStats().attemptsSubmitted).toBe(1);
  });

  it('transitions to submitted after ack events', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const attempt = engine.submit(
      makeIntent([leg('deribit', 'buy', '1000', '1'), leg('okx', 'sell', '1100', '1')]),
      1000,
    );
    engine.onOrderEvent(attempt.id, 0, { kind: 'ack', tsMs: 1001 }, 1001);
    engine.onOrderEvent(attempt.id, 1, { kind: 'ack', tsMs: 1001 }, 1001);
    expect(attempt.status).toBe('submitted');
    expect(attempt.legs[0]!.status).toBe('submitted');
    expect(attempt.legs[1]!.status).toBe('submitted');
  });

  it('fills both legs and records PaperFills with fees', () => {
    const engine = new OmsEngine({
      timeoutMs: 5000,
      maxAttempts: 1,
      feeSchedules: DEFAULT_FEE_SCHEDULES,
    });
    const attempt = engine.submit(
      makeIntent([leg('deribit', 'buy', '1000', '1'), leg('okx', 'sell', '1100', '1')]),
      1000,
    );
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'fill', tsMs: 1001, priceUsd: dec('1000'), sizeCoin: dec('1') },
      1001,
    );
    engine.onOrderEvent(
      attempt.id,
      1,
      { kind: 'fill', tsMs: 1002, priceUsd: dec('1100'), sizeCoin: dec('1') },
      1002,
    );
    expect(attempt.status).toBe('filled');
    expect(attempt.fills).toHaveLength(2);
    expect(attempt.fills[0]!.feeUsd.gt(0)).toBe(true);
    expect(attempt.fills[1]!.feeUsd.gt(0)).toBe(true);
    expect(attempt.legs[0]!.avgFillPriceUsd.toString()).toBe('1000');
    expect(attempt.legs[1]!.avgFillPriceUsd.toString()).toBe('1100');
  });

  it('computes weighted average fill price for partial fills', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const attempt = engine.submit(
      makeIntent([
        leg('deribit', 'buy', '1000', '2') as ExecutionLeg,
        leg('okx', 'sell', '1100', '2'),
      ]),
      1000,
    );
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'partial_fill', tsMs: 1001, priceUsd: dec('1000'), sizeCoin: dec('1') },
      1001,
    );
    expect(attempt.legs[0]!.status).toBe('partially_filled');
    expect(attempt.legs[0]!.avgFillPriceUsd.toString()).toBe('1000');
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'partial_fill', tsMs: 1002, priceUsd: dec('1200'), sizeCoin: dec('1') },
      1002,
    );
    expect(attempt.legs[0]!.status).toBe('filled');
    expect(attempt.legs[0]!.avgFillPriceUsd.toString()).toBe('1100');
  });

  it('detects leg risk when one leg is filled and the other is rejected', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000);
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'fill', tsMs: 1001, priceUsd: dec('1000'), sizeCoin: dec('1') },
      1001,
    );
    expect(engine.legRiskDetected(attempt, 1001)).toBe(false);
    engine.onOrderEvent(
      attempt.id,
      1,
      { kind: 'reject', tsMs: 1002, reason: 'no liquidity' },
      1002,
    );
    expect(engine.legRiskDetected(attempt, 1002)).toBe(true);
  });

  it('detects leg risk after the grace period expires', () => {
    const engine = new OmsEngine({ timeoutMs: 100, maxAttempts: 1 });
    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000);
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'fill', tsMs: 1001, priceUsd: dec('1000'), sizeCoin: dec('1') },
      1001,
    );
    expect(engine.legRiskDetected(attempt, 1050)).toBe(false);
    expect(engine.legRiskDetected(attempt, 1101)).toBe(true);
  });

  it('cancels pending legs on timeout and emits leg-risk for a filled partial', () => {
    const engine = new OmsEngine({ timeoutMs: 100, maxAttempts: 1 });
    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000);
    engine.onOrderEvent(
      attempt.id,
      0,
      { kind: 'fill', tsMs: 1001, priceUsd: dec('1000'), sizeCoin: dec('1') },
      1001,
    );
    engine.tick(1101, []);
    expect(attempt.legs[1]!.status).toBe('expired');
    expect(attempt.status).toBe('partially_filled');
    expect(engine.getStats().legRiskEvents).toBe(1);
    expect(engine.getStats().stuckOrders).toBe(1);
  });

  it('retries terminal attempts up to maxAttempts and then gives up', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 3 });
    const sender = new RejectAllSender(engine);
    engine.setCommandSender(sender);
    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000);
    expect(attempt.status).toBe('rejected');
    expect(engine.getStats().attemptsSubmitted).toBe(3);
  });

  it('records cancel and reject events in leg history', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const attempt = engine.submit(
      makeIntent([leg('deribit', 'buy', '1000', '1'), leg('okx', 'sell', '1100', '1')]),
      1000,
    );
    engine.onOrderEvent(attempt.id, 0, { kind: 'reject', tsMs: 1001, reason: 'blocked' }, 1001);
    engine.onOrderEvent(attempt.id, 1, { kind: 'cancel', tsMs: 1002, reason: 'user' }, 1002);
    expect(attempt.legs[0]!.history.some((h) => h.event === 'reject' && h.note === 'blocked')).toBe(
      true,
    );
    expect(attempt.legs[1]!.history.some((h) => h.event === 'cancel' && h.note === 'user')).toBe(
      true,
    );
    expect(attempt.status).toBe('rejected');
  });
});

describe('PaperOrderSimulator', () => {
  it('fills legs at top-of-book from the supplied view', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const portfolio = new PaperPortfolio();
    const simulator = new PaperOrderSimulator(engine, portfolio, {
      slippageBps: dec(0),
      fees: DEFAULT_FEE_SCHEDULES,
    });

    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000); // no sender → stays pending
    const views = [
      viewForBoth('deribit:BTC-OPT', ['990', '1005'], 'okx:BTC-OPT', ['1095', '1105']),
    ];
    simulator.submit(attempt, 0, views, 1001);
    simulator.submit(attempt, 1, views, 1002);
    expect(attempt.legs[0]!.avgFillPriceUsd.toString()).toBe('1005'); // ask
    expect(attempt.legs[1]!.avgFillPriceUsd.toString()).toBe('1095'); // bid
  });

  it('applies positive slippage to make fills worse', () => {
    const engine = new OmsEngine({ timeoutMs: 5000, maxAttempts: 1 });
    const portfolio = new PaperPortfolio();
    const simulator = new PaperOrderSimulator(engine, portfolio, {
      slippageBps: dec('10'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    engine.setCommandSender(simulator);
    const intent = makeIntent([
      leg('deribit', 'buy', '1000', '1'),
      leg('okx', 'sell', '1100', '1'),
    ]);
    const attempt = engine.submit(intent, 1000);
    // request price fallback because empty views in submit
    const buyPrice = attempt.legs[0]!.avgFillPriceUsd;
    const sellPrice = attempt.legs[1]!.avgFillPriceUsd;
    expect(buyPrice.gt(dec('1000'))).toBe(true);
    expect(sellPrice.lt(dec('1100'))).toBe(true);
    expect(buyPrice.toFixed(4)).toBe('1001.0000'); // 1000 * 1.001
    expect(sellPrice.toFixed(4)).toBe('1098.9000'); // 1100 * 0.999
  });
});

describe('PaperExecutor OMS mode', () => {
  it('executes a two-legged intent through the OMS and updates the portfolio', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
      oms: { enabled: true, legTimeoutMs: 5000, maxAttempts: 1, slippageBps: dec(0) },
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
    );
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    expect(outcome.result.fills).toHaveLength(2);
    expect(outcome.result.grossEdgeUsd.toFixed(2)).toBe('100.00');
    expect(outcome.result.netEdgeUsd.toFixed(2)).toBe('40.00');
    expect(executor.portfolio.getPosition('okx', 'okx:BTC-OPT')?.qty.toString()).toBe('1');
    expect(executor.portfolio.getPosition('deribit', 'deribit:BTC-OPT')?.qty.toString()).toBe('-1');
  });

  it('scales the OMS request when notionals exceed maxNotionalUsd', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('500'),
      fees: DEFAULT_FEE_SCHEDULES,
      oms: { enabled: true, legTimeoutMs: 5000, maxAttempts: 1, slippageBps: dec(0) },
    });
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
    );
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    expect(outcome.result.fills[0]!.sizeCoin.toFixed(4)).toBe('0.4545');
    expect(outcome.result.fills[1]!.sizeCoin.toFixed(4)).toBe('0.4545');
  });

  it('returns skipped when OMS attempt is rejected', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
      oms: { enabled: true, legTimeoutMs: 5000, maxAttempts: 1, slippageBps: dec(0) },
    });
    // Reach into the engine and replace the simulator with a reject sender.
    const engine = (executor as unknown as { omsEngine: OmsEngine }).omsEngine;
    engine.setCommandSender(new RejectAllSender(engine));
    const outcome = executor.execute(
      makeIntent([leg('okx', 'buy', '1000', '1'), leg('deribit', 'sell', '1100', '1')]),
    );
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') return;
    expect(outcome.reason).toContain('rejected');
  });
});

describe('PaperExecutor legacy mode', () => {
  it('keeps atomic two-leg fill behavior when OMS is disabled', () => {
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
    expect(outcome.result.netEdgeUsd.toFixed(2)).toBe('40.00');
  });

  it('omsStats returns zeros when OMS is disabled', () => {
    const executor = new PaperExecutor({
      maxNotionalUsd: dec('10000'),
      fees: DEFAULT_FEE_SCHEDULES,
    });
    expect(executor.omsStats()).toEqual({
      attemptsSubmitted: 0,
      legRiskEvents: 0,
      stuckOrders: 0,
    });
  });
});
