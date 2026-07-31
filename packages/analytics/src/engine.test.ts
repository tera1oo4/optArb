import { describe, expect, it } from 'vitest';
import { AnalyticsEngine } from './engine.js';
import { InMemoryTradeLog } from './in-memory-trade-log.js';
import { makeFill, makeSnapshot } from './test-helpers.js';

describe('AnalyticsEngine', () => {
  it('computes a report from an in-memory trade log', async () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const snapshots = [makeSnapshot(0, 1), makeSnapshot(490, 2)];
    const log = new InMemoryTradeLog({ fills, portfolioSnapshots: snapshots });
    const engine = new AnalyticsEngine(log);
    const report = await engine.computeReport({
      from: new Date('2026-07-01'),
      to: new Date('2026-07-08'),
    });

    expect(report.totalSignals).toBe(1);
    expect(report.totalFills).toBe(2);
    expect(report.netPnl.toNumber()).toBe(490);
    expect(report.period.from?.toISOString().startsWith('2026-07-01')).toBe(true);
    expect(report.period.to?.toISOString().startsWith('2026-07-08')).toBe(true);
  });

  it('aggregates risk decisions separately from fills', async () => {
    const log = new InMemoryTradeLog({
      fills: [makeFill('s1', 'deribit', 'buy', 8_000, 1, 5)],
      riskDecisions: [{ signalId: 's2', allowed: false, reasons: ['limit'], checkedAtMs: 2_000 }],
    });
    const engine = new AnalyticsEngine(log);
    const report = await engine.computeReport();
    expect(report.totalSignals).toBe(2);
    expect(report.totalRiskRejects).toBe(1);
    expect(report.totalFills).toBe(1);
  });
});
