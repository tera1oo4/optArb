import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dec, type Logger, type RawCapture, type Venue } from '@optarb/core';
import { DEFAULT_FEE_SCHEDULES } from '@optarb/execution';
import type { RiskConfig } from '@optarb/risk';
import { BacktestEngine, formatReport } from './engine.js';

const INDEX_PRICE = 100_000;

function captureEntry(venue: Venue, tsMs: number, payload: unknown): RawCapture {
  return { tsMs, venue, channel: 'ws', direction: 'in', payload };
}

function deribitTicker(symbol: string, tsMs: number, bidBtc: number, askBtc: number): RawCapture {
  return captureEntry('deribit', tsMs, {
    method: 'subscription',
    params: {
      channel: `ticker.${symbol}.100ms`,
      data: {
        instrument_name: symbol,
        timestamp: tsMs,
        best_bid_price: bidBtc,
        best_ask_price: askBtc,
        mark_price: (bidBtc + askBtc) / 2,
        index_price: INDEX_PRICE,
        mark_iv: 55,
      },
    },
  });
}

function deribitBook(
  symbol: string,
  tsMs: number,
  changeId: number,
  bidBtc: number,
  askBtc: number,
): RawCapture {
  return captureEntry('deribit', tsMs, {
    method: 'subscription',
    params: {
      channel: `book.${symbol}.100ms`,
      data: {
        timestamp: tsMs,
        instrument_name: symbol,
        change_id: changeId,
        bids: [['new', bidBtc, 1]],
        asks: [['new', askBtc, 1]],
      },
    },
  });
}

function bybitTicker(symbol: string, tsMs: number, bidUsdt: string, askUsdt: string): RawCapture {
  return captureEntry('bybit', tsMs, {
    topic: `tickers.${symbol}`,
    type: 'snapshot',
    ts: tsMs,
    data: {
      symbol,
      bidPrice: bidUsdt,
      bidSize: '1',
      askPrice: askUsdt,
      askSize: '1',
      indexPrice: String(INDEX_PRICE),
      markPriceIv: '0.55',
    },
  });
}

function bybitBook(
  symbol: string,
  tsMs: number,
  updateId: number,
  bidUsdt: string,
  askUsdt: string,
): RawCapture {
  return captureEntry('bybit', tsMs, {
    topic: `orderbook.50.${symbol}`,
    type: 'snapshot',
    ts: tsMs,
    data: {
      s: symbol,
      u: updateId,
      b: [[bidUsdt, '1']],
      a: [[askUsdt, '1']],
    },
  });
}

function makeFeeSchedules() {
  return DEFAULT_FEE_SCHEDULES;
}

function makeBaseRiskConfig(): RiskConfig {
  return {
    RISK_MAX_NOTIONAL_PER_TRADE_USD: 200_000,
    RISK_MAX_NOTIONAL_PER_VENUE_USD: 500_000,
    RISK_MAX_NOTIONAL_GLOBAL_USD: 1_000_000,
    RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: 500_000,
    RISK_MAX_DAILY_LOSS_USD: 50_000,
    RISK_MAX_QUOTE_AGE_MS: 2_000,
    RISK_MIN_EDGE_AFTER_FEES_BPS: 5,
    RISK_KILL_SWITCH: false,
  };
}

function writeTempCapture(entries: RawCapture[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'optarb-backtest-'));
  const file = join(dir, 'capture.jsonl');
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(file, lines, 'utf8');
  return file;
}

describe('BacktestEngine', () => {
  let engine: BacktestEngine;
  const symbol = 'BTC-26SEP26-80000-C';

  beforeEach(() => {
    engine = new BacktestEngine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts raw and skipped entries', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.08, 0.09),
      captureEntry('deribit', 1_000, 'not-json-rpc'),
      captureEntry('unknown' as Venue, 1_000, {}),
      { tsMs: 1_000, venue: 'deribit', channel: 'ws', direction: 'out', payload: {} },
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(10_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.rawEntries).toBe(4);
    // unknown venue + outbound direction; the non-subscription payload yields no event but is not malformed.
    expect(result.skippedEntries).toBe(2);
    expect(result.gaps).toBe(0);
  });

  it('detects cross-venue signal and executes closing fills with positive net PnL', async () => {
    // Signal 1: buy Deribit @ 8000, sell Bybit @ 8500.
    // Signal 2 (closing): buy Bybit @ 9500, sell Deribit @ 10000.
    const file = writeTempCapture([
      // t = 1000: open signal
      deribitTicker(symbol, 1_000, 0.07, 0.08),
      bybitTicker(symbol, 1_000, '8500', '9500'),
      deribitBook(symbol, 1_000, 1, 0.07, 0.08),
      bybitBook(symbol, 1_000, 1, '8500', '9500'),
      // t = 2000: close signal (sell Deribit rich, buy Bybit cheap)
      deribitTicker(symbol, 2_000, 0.11, 0.12),
      bybitTicker(symbol, 2_000, '9500', '10500'),
      deribitBook(symbol, 2_000, 2, 0.11, 0.12),
      bybitBook(symbol, 2_000, 2, '9500', '10500'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.rawEntries).toBe(8);
    expect(result.skippedEntries).toBe(0);
    expect(result.gaps).toBe(0);
    expect(result.signalsSeen).toBeGreaterThanOrEqual(2);
    expect(result.riskRejects).toBe(0);
    expect(result.fills).toBe(4);
    expect(result.realizedPnl.gt(0)).toBe(true);
    expect(result.netPnl.gt(0)).toBe(true);
    expect(result.finalPortfolioSnapshot.openPositions).toBe(0);
  });

  it('counts sequence gap and recovers', async () => {
    const file = writeTempCapture([
      captureEntry('bybit', 1_000, {
        topic: `orderbook.50.${symbol}`,
        type: 'snapshot',
        ts: 1_000,
        data: { s: symbol, u: 1, b: [['8500', '1']], a: [['9500', '1']] },
      }),
      // Gap: prev expected u=1, got u=3
      captureEntry('bybit', 1_001, {
        topic: `orderbook.50.${symbol}`,
        type: 'delta',
        ts: 1_001,
        data: { s: symbol, u: 3, b: [['8600', '1']], a: [['9600', '1']] },
      }),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(10_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.gaps).toBe(1);
    expect(result.skippedEntries).toBe(0);
  });

  it('rejects intent when per-trade notional limit is breached', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.07, 0.08),
      bybitTicker(symbol, 1_000, '8500', '9500'),
      deribitBook(symbol, 1_000, 1, 0.07, 0.08),
      bybitBook(symbol, 1_000, 1, '8500', '9500'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: { ...makeBaseRiskConfig(), RISK_MAX_NOTIONAL_PER_TRADE_USD: 1_000 },
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.signalsSeen).toBeGreaterThanOrEqual(1);
    expect(result.riskRejects).toBeGreaterThanOrEqual(1);
    expect(result.fills).toBe(0);
  });

  it('logs intermediate portfolio snapshots at report interval', async () => {
    const info = vi.fn();
    const log: Logger = { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() };
    const customEngine = new BacktestEngine(log);

    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.07, 0.08),
      bybitTicker(symbol, 1_000, '8500', '9500'),
      deribitBook(symbol, 1_000, 1, 0.07, 0.08),
      bybitBook(symbol, 1_000, 1, '8500', '9500'),
    ]);

    await customEngine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 1_000,
      scanIntervalMs: 1_000,
    });

    const snapshotCalls = info.mock.calls.filter(([msg]) => msg === 'backtest: portfolio snapshot');
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('advances virtual clock with capture timestamps', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 5_000, 0.07, 0.08),
      bybitTicker(symbol, 5_000, '8500', '9500'),
      deribitBook(symbol, 5_000, 1, 0.07, 0.08),
      bybitBook(symbol, 5_000, 1, '8500', '9500'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.durationMs).toBe(0); // single timestamp bucket
    expect(result.signalsSeen).toBeGreaterThanOrEqual(1);
  });

  it('skips outbound capture entries', async () => {
    const file = writeTempCapture([
      {
        tsMs: 1_000,
        venue: 'deribit',
        channel: 'ws',
        direction: 'out',
        payload: { method: 'ping' },
      },
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(10_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.rawEntries).toBe(1);
    expect(result.skippedEntries).toBe(1);
  });

  it('formatReport includes key metrics', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.07, 0.08),
      bybitTicker(symbol, 1_000, '8500', '9500'),
      deribitBook(symbol, 1_000, 1, 0.07, 0.08),
      bybitBook(symbol, 1_000, 1, '8500', '9500'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    const report = formatReport(result);
    expect(report).toContain('Backtest Report');
    expect(report).toContain(`Signals seen:     ${result.signalsSeen}`);
    expect(report).toContain(`Fills:            ${result.fills}`);
    expect(report).toContain(`Net PnL:          ${result.netPnl.toFixed(2)} USD`);
  });

  it('executes nothing when spread is below threshold', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.085, 0.086),
      bybitTicker(symbol, 1_000, '8600', '8700'),
      deribitBook(symbol, 1_000, 1, 0.085, 0.086),
      bybitBook(symbol, 1_000, 1, '8600', '8700'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(200), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.fills).toBe(0);
  });

  it('reports zero metrics for empty capture', async () => {
    const file = writeTempCapture([]);
    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: makeBaseRiskConfig(),
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(10_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.rawEntries).toBe(0);
    expect(result.skippedEntries).toBe(0);
    expect(result.gaps).toBe(0);
    expect(result.signalsSeen).toBe(0);
    expect(result.fills).toBe(0);
    expect(result.netPnl.toNumber()).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it('respects kill switch', async () => {
    const file = writeTempCapture([
      deribitTicker(symbol, 1_000, 0.07, 0.08),
      bybitTicker(symbol, 1_000, '8500', '9500'),
      deribitBook(symbol, 1_000, 1, 0.07, 0.08),
      bybitBook(symbol, 1_000, 1, '8500', '9500'),
    ]);

    const result = await engine.run({
      captureFile: file,
      signalConfig: { minSpreadBps: dec(25), maxQuoteAgeMs: 2_000, minSizeUsd: dec(1_000) },
      riskConfig: { ...makeBaseRiskConfig(), RISK_KILL_SWITCH: true },
      feeSchedules: makeFeeSchedules(),
      paperMaxNotionalUsd: dec(100_000),
      reportIntervalMs: 60_000,
      scanIntervalMs: 1_000,
    });

    expect(result.signalsSeen).toBeGreaterThanOrEqual(1);
    expect(result.riskRejects).toBeGreaterThanOrEqual(1);
    expect(result.fills).toBe(0);
  });
});
