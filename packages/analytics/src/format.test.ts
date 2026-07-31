import { describe, expect, it } from 'vitest';
import {
  comparePeriods,
  formatComparison,
  formatReport,
  reportToCsv,
  reportToJson,
} from './format.js';
import { computeReport } from './metrics.js';
import { makeFill, makeSnapshot } from './test-helpers.js';

describe('formatReport', () => {
  it('includes summary and breakdown sections', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    const text = formatReport(report);
    expect(text).toContain('Analytics Report');
    expect(text).toContain('Total signals');
    expect(text).toContain('deribit');
    expect(text).toContain('cross-venue');
  });
});

describe('reportToCsv', () => {
  it('produces a non-empty CSV with summary rows', () => {
    const fills = [makeFill('s1', 'deribit', 'buy', 8_000, 1, 5)];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    const csv = reportToCsv(report);
    expect(csv).toContain('section,key,value');
    expect(csv).toContain('summary,totalFills,1');
    expect(csv.split('\n').length).toBeGreaterThan(3);
  });
});

describe('reportToJson', () => {
  it('serialises decimal fields as strings', () => {
    const fills = [makeFill('s1', 'deribit', 'buy', 8_000, 1, 5)];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    const json = reportToJson(report) as { netPnl: string | null };
    expect(json.netPnl).toBe('-8005.00000000'); // buy cost + fee
  });
});

describe('comparePeriods', () => {
  it('computes absolute and percent deltas between two reports', () => {
    const fillsA = [makeFill('s1', 'deribit', 'buy', 8_000, 1, 5)];
    const reportA = computeReport({ orders: [], fills: fillsA, decisions: [], snapshots: [] });
    const fillsB = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s2', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const reportB = computeReport({ orders: [], fills: fillsB, decisions: [], snapshots: [] });
    const comparison = comparePeriods(reportA, reportB);
    expect(comparison.deltas.totalFills).toBeDefined();
    expect(comparison.deltas.totalFills!.absolute.toNumber()).toBe(1);
    expect(comparison.deltas.totalFills!.percent?.toNumber()).toBe(100);
    const text = formatComparison(comparison);
    expect(text).toContain('Period Comparison');
    expect(text).toContain('totalFills');
  });
});
