import 'dotenv/config';
import { resolve } from 'node:path';
import pino from 'pino';
import { dec, LOG_REDACT_PATHS, type Logger } from '@optarb/core';
import type { Venue } from '@optarb/core';
import {
  AnalyticsEngine,
  formatReport as formatAnalyticsReport,
  InMemoryTradeLog,
} from '@optarb/analytics';
import { BacktestEngine, formatReport } from '@optarb/backtest-engine';
import { resolveFeeSchedules } from '@optarb/execution';
import { loadConfig } from './config.js';

function toLogger(log: pino.Logger): Logger {
  return {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}

function feeOverrides(cfg: ReturnType<typeof loadConfig>) {
  const out: Partial<
    Record<Venue, { takerFeeRate?: string; premiumCapFraction?: string; makerFeeRate?: string }>
  > = {};
  const set = (v: Venue, taker?: string, cap?: string, maker?: string) => {
    if (taker || cap || maker)
      out[v] = { takerFeeRate: taker, premiumCapFraction: cap, makerFeeRate: maker };
  };
  set('deribit', cfg.PAPER_FEE_DERIBIT_TAKER_RATE, cfg.PAPER_FEE_DERIBIT_CAP_FRACTION);
  set('bybit', cfg.PAPER_FEE_BYBIT_TAKER_RATE, cfg.PAPER_FEE_BYBIT_CAP_FRACTION);
  set('okx', cfg.PAPER_FEE_OKX_TAKER_RATE, cfg.PAPER_FEE_OKX_CAP_FRACTION);
  set('binance', cfg.PAPER_FEE_BINANCE_TAKER_RATE, cfg.PAPER_FEE_BINANCE_CAP_FRACTION);
  if (cfg.PAPER_FEE_POLYMARKET_TAKER_RATE) {
    out.polymarket = { takerFeeRate: cfg.PAPER_FEE_POLYMARKET_TAKER_RATE };
  }
  return out;
}

function resolveCaptureFile(file: string): string {
  if (file.startsWith('/')) return file;
  const cwd = process.env.INIT_CWD ?? process.cwd();
  return resolve(cwd, file);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: pnpm backtest <capture-file.jsonl>');
    process.exit(1);
  }

  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL, redact: LOG_REDACT_PATHS });

  const engine = new BacktestEngine(toLogger(log));
  const result = await engine.run({
    captureFile: resolveCaptureFile(file),
    signalConfig: {
      minSpreadBps: dec(cfg.SIGNAL_MIN_SPREAD_BPS),
      maxQuoteAgeMs: cfg.SIGNAL_MAX_QUOTE_AGE_MS,
      minSizeUsd: dec(cfg.SIGNAL_MIN_SIZE_USD),
    },
    riskConfig: {
      RISK_MAX_NOTIONAL_PER_TRADE_USD: cfg.RISK_MAX_NOTIONAL_PER_TRADE_USD,
      RISK_MAX_NOTIONAL_PER_VENUE_USD: cfg.RISK_MAX_NOTIONAL_PER_VENUE_USD,
      RISK_MAX_NOTIONAL_GLOBAL_USD: cfg.RISK_MAX_NOTIONAL_GLOBAL_USD,
      RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: cfg.RISK_MAX_EXPOSURE_PER_UNDERLYING_USD,
      RISK_MAX_DAILY_LOSS_USD: cfg.RISK_MAX_DAILY_LOSS_USD,
      RISK_MAX_DAILY_DRAWDOWN_USD: cfg.RISK_MAX_DAILY_DRAWDOWN_USD,
      RISK_MAX_QUOTE_AGE_MS: cfg.RISK_MAX_QUOTE_AGE_MS,
      RISK_MIN_EDGE_AFTER_FEES_BPS: cfg.RISK_MIN_EDGE_AFTER_FEES_BPS,
      RISK_MAX_INDEX_DIVERGENCE_BPS: cfg.RISK_MAX_INDEX_DIVERGENCE_BPS,
      RISK_MAX_LEG_SKEW_MS: cfg.RISK_MAX_LEG_SKEW_MS,
      RISK_KILL_SWITCH: cfg.RISK_KILL_SWITCH,
      RISK_MAX_DELTA_PER_UNDERLYING: cfg.RISK_MAX_DELTA_PER_UNDERLYING,
      RISK_MAX_VEGA_PER_UNDERLYING_USD: cfg.RISK_MAX_VEGA_PER_UNDERLYING_USD,
      RISK_MAX_GAMMA_PER_UNDERLYING_USD: cfg.RISK_MAX_GAMMA_PER_UNDERLYING_USD,
      RISK_MIN_MARGIN_HEADROOM_USD: cfg.RISK_MIN_MARGIN_HEADROOM_USD,
      RISK_MAX_POLYMARKET_SETTLEMENT_USD: cfg.RISK_MAX_POLYMARKET_SETTLEMENT_USD,
      RISK_AUTO_KILL_HEARTBEAT_IDLE_MS: cfg.RISK_AUTO_KILL_HEARTBEAT_IDLE_MS,
      RISK_AUTO_KILL_SEQUENCE_GAPS: cfg.RISK_AUTO_KILL_SEQUENCE_GAPS,
      RISK_AUTO_KILL_SEQUENCE_WINDOW_MS: cfg.RISK_AUTO_KILL_SEQUENCE_WINDOW_MS,
      RISK_AUTO_KILL_REJECT_COUNT: cfg.RISK_AUTO_KILL_REJECT_COUNT,
      RISK_AUTO_KILL_REJECT_WINDOW_MS: cfg.RISK_AUTO_KILL_REJECT_WINDOW_MS,
    },
    feeSchedules: resolveFeeSchedules(feeOverrides(cfg)),
    paperMaxNotionalUsd: dec(cfg.PAPER_MAX_NOTIONAL_USD),
    reportIntervalMs: cfg.PAPER_REPORT_INTERVAL_MS,
    scanIntervalMs: cfg.SCAN_INTERVAL_MS,
    captureTradeLog: cfg.BACKTEST_ANALYTICS,
  });

  log.info({ file }, 'backtest finished');
  console.log(formatReport(result));

  if (cfg.BACKTEST_ANALYTICS && result.tradeLog) {
    const log = new InMemoryTradeLog({
      fills: result.tradeLog.fills,
      orders: result.tradeLog.orders,
      riskDecisions: result.tradeLog.riskDecisions,
      portfolioSnapshots: result.tradeLog.portfolioSnapshots,
    });
    const analytics = new AnalyticsEngine(log);
    const analyticsReport = await analytics.computeReport();
    console.log('\n' + formatAnalyticsReport(analyticsReport));
  }
}

main().catch((err: unknown) => {
  console.error('backtest fatal error', err);
  process.exit(1);
});
