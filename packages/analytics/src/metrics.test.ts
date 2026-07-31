import { dec } from '@optarb/core';
import { describe, expect, it } from 'vitest';
import { computeReport } from './metrics.js';
import { makeFill, makeSnapshot } from './test-helpers.js';

describe('computeReport', () => {
  it('returns zero/null metrics for empty data', () => {
    const report = computeReport({ orders: [], fills: [], decisions: [], snapshots: [] });
    expect(report.totalSignals).toBe(0);
    expect(report.totalFills).toBe(0);
    expect(report.totalRiskRejects).toBe(0);
    expect(report.rejectRate).toBeNull();
    expect(report.grossPnl.toNumber()).toBe(0);
    expect(report.fees.toNumber()).toBe(0);
    expect(report.netPnl.toNumber()).toBe(0);
    expect(report.avgPnlPerFill.toNumber()).toBe(0);
    expect(report.winRate).toBeNull();
    expect(report.avgEdgeAfterFeesBps).toBeNull();
    expect(report.maxDrawdown.toNumber()).toBe(0);
    expect(report.sharpe).toBeNull();
    expect(report.horizonHitRate).toBeNull();
  });

  it('computes basic PnL and fees from a single cross-venue pair', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.totalFills).toBe(2);
    expect(report.grossPnl.toNumber()).toBe(500);
    expect(report.fees.toNumber()).toBe(10);
    expect(report.netPnl.toNumber()).toBe(490);
    expect(report.winRate?.toNumber()).toBe(100);
  });

  it('reports 0% win rate when all trades lose', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_500, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_000, 1, 5),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.winRate?.toNumber()).toBe(0);
    expect(report.netPnl.toNumber()).toBe(-510);
  });

  it('computes per-venue and per-underlying breakdowns', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5, 'BTC'),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5, 'BTC'),
      makeFill('s2', 'okx', 'buy', 3_000, 1, 3, 'ETH'),
      makeFill('s2', 'binance', 'sell', 2_900, 1, 3, 'ETH'),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.perVenue.deribit?.fills).toBe(1);
    expect(report.perVenue.bybit?.fills).toBe(1);
    expect(report.perVenue.okx?.fills).toBe(1);
    expect(report.perVenue.binance?.fills).toBe(1);
    expect(report.perUnderlying.BTC?.fills).toBe(2);
    expect(report.perUnderlying.ETH?.fills).toBe(2);
  });

  it('computes per-detector metrics from orders', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
    ];
    const orders = [
      {
        signalId: 's1',
        signalKind: 'cross-venue',
        venueBuy: 'deribit' as const,
        venueSell: 'bybit' as const,
        requestedNotionalUsd: dec(8_000),
        status: 'executed' as const,
        createdAtMs: 1_000,
      },
    ];
    const report = computeReport({ orders, fills, decisions: [], snapshots: [] });
    expect(report.perDetector['cross-venue']).toBeDefined();
    expect(report.perDetector['cross-venue']!.signals).toBe(1);
    expect(report.perDetector['cross-venue']!.executed).toBe(1);
    expect(report.perDetector['cross-venue']!.fills).toBe(2);
    expect(report.perDetector['cross-venue']!.winRate?.toNumber()).toBe(100);
  });

  it('computes max drawdown from portfolio snapshots', () => {
    const snapshots = [
      makeSnapshot(100, 1),
      makeSnapshot(50, 2),
      makeSnapshot(120, 3),
      makeSnapshot(80, 4),
    ];
    const report = computeReport({ orders: [], fills: [], decisions: [], snapshots });
    expect(report.maxDrawdown.toNumber()).toBe(50); // peak 100 -> trough 50
  });

  it('returns sharpe null when all per-trade PnLs are equal (zero std)', () => {
    const fills = [
      ...[1, 2, 3].flatMap((i) => [
        makeFill(`s${i}`, 'deribit', 'buy', 8_000, 1, 0),
        makeFill(`s${i}`, 'bybit', 'sell', 8_500, 1, 0),
      ]),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.sharpe).toBeNull();
  });

  it('computes positive sharpe for winning trades', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 5),
      makeFill('s1', 'bybit', 'sell', 8_500, 1, 5),
      makeFill('s2', 'deribit', 'buy', 7_000, 1, 5),
      makeFill('s2', 'bybit', 'sell', 7_600, 1, 5),
    ];
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.sharpe).not.toBeNull();
    expect(report.sharpe!.gt(0)).toBe(true);
  });

  it('counts risk rejects and computes reject rate', () => {
    const decisions = [
      { signalId: 's1', allowed: false, reasons: ['limit'], checkedAtMs: 1_000 },
      { signalId: 's2', allowed: false, reasons: ['kill-switch'], checkedAtMs: 2_000 },
    ];
    const report = computeReport({ orders: [], fills: [], decisions, snapshots: [] });
    expect(report.totalRiskRejects).toBe(2);
    expect(report.rejectRate?.toNumber()).toBe(100);
  });

  it('computes average edge after fees in bps for cross-venue', () => {
    const fills = [
      makeFill('s1', 'deribit', 'buy', 8_000, 1, 80),
      makeFill('s1', 'bybit', 'sell', 8_400, 1, 80),
    ];
    // gross 400, fees 160, net 240 -> 240/8000*10000 = 300 bps
    const report = computeReport({ orders: [], fills, decisions: [], snapshots: [] });
    expect(report.avgEdgeAfterFeesBps?.toNumber()).toBe(300);
  });
});
