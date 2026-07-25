import 'dotenv/config';
import { resolve } from 'node:path';
import pino from 'pino';
import { dec, type Logger } from '@optarb/core';
import type { Venue } from '@optarb/core';
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
  const log = pino({ level: cfg.LOG_LEVEL });

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
      RISK_MAX_QUOTE_AGE_MS: cfg.RISK_MAX_QUOTE_AGE_MS,
      RISK_MIN_EDGE_AFTER_FEES_BPS: cfg.RISK_MIN_EDGE_AFTER_FEES_BPS,
      RISK_KILL_SWITCH: cfg.RISK_KILL_SWITCH,
    },
    feeSchedules: resolveFeeSchedules(feeOverrides(cfg)),
    paperMaxNotionalUsd: dec(cfg.PAPER_MAX_NOTIONAL_USD),
    reportIntervalMs: cfg.PAPER_REPORT_INTERVAL_MS,
    scanIntervalMs: cfg.SCAN_INTERVAL_MS,
  });

  log.info({ file }, 'backtest finished');
  console.log(formatReport(result));
}

main().catch((err: unknown) => {
  console.error('backtest fatal error', err);
  process.exit(1);
});
