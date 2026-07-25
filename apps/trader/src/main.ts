import 'dotenv/config';
import pino from 'pino';
import {
  dec,
  InMemoryEventBus,
  LiveClock,
  nullCapture,
  type Decimal,
  type Logger,
  type Venue,
} from '@optarb/core';
import {
  PaperExecutor,
  resolveFeeSchedules,
  type ExecutionIntent,
  type ExecutionOutcome,
  type PaperFill,
} from '@optarb/execution';
import { MarketDataStore, type InstrumentView } from '@optarb/marketdata';
import { RiskEngine, riskStateFromSnapshot } from '@optarb/risk';
import { CrossVenueDetector, type CrossVenueSignal } from '@optarb/signals';
import { createVenueConnector, type VenueRuntimeConfigs } from '@optarb/venues';
import { loadConfig } from './config.js';
import { SignalTracker } from './signal-tracker.js';

function toLogger(log: pino.Logger): Logger {
  return {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}

function venueConfigs(cfg: ReturnType<typeof loadConfig>): VenueRuntimeConfigs {
  return {
    deribit: {
      wsUrl: cfg.DERIBIT_WS_URL,
      restUrl: cfg.DERIBIT_REST_URL,
      currency: cfg.DERIBIT_CURRENCY,
      maxInstruments: cfg.DERIBIT_MAX_INSTRUMENTS,
      bookDepth: cfg.DERIBIT_BOOK_DEPTH,
    },
    bybit: {
      wsUrl: cfg.BYBIT_WS_URL,
      restUrl: cfg.BYBIT_REST_URL,
      baseCoin: cfg.BYBIT_BASE_COIN,
      maxInstruments: cfg.BYBIT_MAX_INSTRUMENTS,
      bookDepth: cfg.BYBIT_BOOK_DEPTH as 1 | 25 | 50 | 100 | 200,
    },
    okx: {
      wsUrl: cfg.OKX_WS_URL,
      restUrl: cfg.OKX_REST_URL,
      demoTrading: cfg.OKX_DEMO_TRADING,
      uly: cfg.OKX_ULY,
      maxInstruments: cfg.OKX_MAX_INSTRUMENTS,
    },
    binance: {
      marketWsUrl: cfg.BINANCE_MARKET_WS_URL,
      publicWsUrl: cfg.BINANCE_PUBLIC_WS_URL,
      restUrl: cfg.BINANCE_REST_URL,
      underlyings: [...cfg.BINANCE_UNDERLYINGS],
      maxInstruments: cfg.BINANCE_MAX_INSTRUMENTS,
      bookDepth: cfg.BINANCE_BOOK_DEPTH as 10 | 20 | 50 | 100,
    },
    polymarket: {
      gammaUrl: cfg.POLYMARKET_GAMMA_URL,
      wsUrl: cfg.POLYMARKET_WS_URL,
      underlyings: [...cfg.POLYMARKET_UNDERLYINGS],
      maxMarkets: cfg.POLYMARKET_MAX_MARKETS,
      bookDepth: cfg.POLYMARKET_BOOK_DEPTH,
    },
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

function crossVenueIntent(signal: CrossVenueSignal, view: InstrumentView): ExecutionIntent | null {
  const buy = view.quotes.get(signal.buyVenue);
  const sell = view.quotes.get(signal.sellVenue);
  if (!buy || !sell) return null;
  if (buy.askUsd === null || sell.bidUsd === null) return null;
  if (buy.askSizeCoin === null || sell.bidSizeCoin === null) return null;

  const sizeCoin = buy.askSizeCoin.lte(sell.bidSizeCoin) ? buy.askSizeCoin : sell.bidSizeCoin;
  const quoteRecvMs = Math.max(buy.recvMs, sell.recvMs);
  return {
    signalId: `cross-venue:${view.key}:${signal.buyVenue}->${signal.sellVenue}:${signal.tsMs}`,
    signalKind: 'cross-venue',
    legs: [
      {
        venue: signal.buyVenue,
        instrumentId: signal.buyInstrumentId,
        viewKey: view.key,
        underlying: view.underlying,
        side: 'buy',
        priceUsd: buy.askUsd,
        sizeCoin,
        indexPriceUsd: buy.indexPriceUsd,
        quoteRecvMs,
      },
      {
        venue: signal.sellVenue,
        instrumentId: signal.sellInstrumentId,
        viewKey: view.key,
        underlying: view.underlying,
        side: 'sell',
        priceUsd: sell.bidUsd,
        sizeCoin,
        indexPriceUsd: sell.indexPriceUsd,
        quoteRecvMs,
      },
    ],
    tsMs: signal.tsMs,
  };
}

function logFill(log: pino.Logger, fill: PaperFill): void {
  log.info(
    {
      signalId: fill.signalId,
      venue: fill.venue,
      instrumentId: fill.instrumentId,
      side: fill.side,
      priceUsd: fill.priceUsd.toString(),
      sizeCoin: fill.sizeCoin.toString(),
      notionalUsd: fill.notionalUsd.toString(),
      feeUsd: fill.feeUsd.toString(),
    },
    'paper fill',
  );
}

function logSignal(log: pino.Logger, s: CrossVenueSignal, level: 'info' | 'debug'): void {
  log[level](
    {
      signal: s.kind,
      key: s.key,
      buy: `${s.buyVenue} @ ${s.buyPriceUsd.toString()}`,
      sell: `${s.sellVenue} @ ${s.sellPriceUsd.toString()}`,
      spreadBps: s.spreadBps.toFixed(1),
      sizeUsd: s.sizeUsd.toFixed(0),
    },
    'cross-venue arb signal',
  );
}

function outcomeLabel(outcome: ExecutionOutcome): string {
  if (outcome.status === 'executed') {
    const r = outcome.result;
    return `executed gross=${r.grossEdgeUsd.toFixed(2)} fees=${r.feesUsd.toFixed(2)} net=${r.netEdgeUsd.toFixed(2)}`;
  }
  return `skipped: ${outcome.reason}`;
}

/**
 * Paper trader (ADR-0006): consumes live market data, maintains the consolidated
 * USD view, emits cross-venue arb signals and records fee-aware virtual fills.
 * NEVER sends orders — paper only. Live execution will require LIVE_TRADING=true
 * + operator confirmation.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });
  const logger = toLogger(log);
  logger.info('trader starting in PAPER mode (no orders will be sent)');

  const bus = new InMemoryEventBus();
  const clock = new LiveClock();
  const store = new MarketDataStore();
  const detector = new CrossVenueDetector({
    minSpreadBps: dec(cfg.SIGNAL_MIN_SPREAD_BPS),
    maxQuoteAgeMs: cfg.SIGNAL_MAX_QUOTE_AGE_MS,
    minSizeUsd: dec(cfg.SIGNAL_MIN_SIZE_USD),
  });
  const executor = new PaperExecutor({
    maxNotionalUsd: dec(cfg.PAPER_MAX_NOTIONAL_USD),
    fees: resolveFeeSchedules(feeOverrides(cfg)),
  });
  const riskEngine = new RiskEngine(
    {
      RISK_MAX_NOTIONAL_PER_TRADE_USD: cfg.RISK_MAX_NOTIONAL_PER_TRADE_USD,
      RISK_MAX_NOTIONAL_PER_VENUE_USD: cfg.RISK_MAX_NOTIONAL_PER_VENUE_USD,
      RISK_MAX_NOTIONAL_GLOBAL_USD: cfg.RISK_MAX_NOTIONAL_GLOBAL_USD,
      RISK_MAX_EXPOSURE_PER_UNDERLYING_USD: cfg.RISK_MAX_EXPOSURE_PER_UNDERLYING_USD,
      RISK_MAX_DAILY_LOSS_USD: cfg.RISK_MAX_DAILY_LOSS_USD,
      RISK_MAX_QUOTE_AGE_MS: cfg.RISK_MAX_QUOTE_AGE_MS,
      RISK_MIN_EDGE_AFTER_FEES_BPS: cfg.RISK_MIN_EDGE_AFTER_FEES_BPS,
      RISK_KILL_SWITCH: cfg.RISK_KILL_SWITCH,
    },
    resolveFeeSchedules(feeOverrides(cfg)),
  );
  const tracker = new SignalTracker(cfg.PAPER_SIGNAL_HORIZONS_MS);

  bus.on('market.ticker', (t) => store.applyTicker(t));
  bus.on('market.book', (b) => store.applyBook(b));
  bus.on('connector.status', (s) => logger.info('connector status', { ...s }));

  const connectors = cfg.VENUES.map((v) =>
    createVenueConnector(v, venueConfigs(cfg), { bus, clock, capture: nullCapture, logger }),
  );

  const running: typeof connectors = [];
  for (const connector of connectors) {
    try {
      const instruments = await connector.loadInstruments();
      for (const inst of instruments) store.registerInstrument(inst);
      logger.info('instruments registered', { venue: connector.venue, count: instruments.length });
      await connector.connect();
      await connector.subscribe(instruments);
      running.push(connector);
    } catch (err) {
      // One venue failing at startup must not kill the paper trader.
      logger.error('venue startup failed, continuing without it', {
        venue: connector.venue,
        err: String(err),
      });
    }
  }
  if (running.length === 0) throw new Error('no venue started — nothing to trade');

  let signalCount = 0;
  let executedCount = 0;
  let riskRejectCount = 0;
  const seenKeys = new Set<string>();
  const dailyRealizedPnlBaseline = executor.portfolio.snapshot(store.views()).realizedPnlUsd;
  const scanTimer = setInterval(() => {
    const nowMs = clock.nowMs();
    const views = store.views();
    const signals = detector.detect(views, nowMs);
    tracker.update(views, nowMs).forEach((o) =>
      log.info(
        {
          signalId: o.signalId,
          entrySpreadBps: o.entrySpreadBps,
          horizonMs: o.horizonMs,
          spreadBps: o.spreadBps,
        },
        'signal outcome',
      ),
    );

    for (const s of signals) {
      signalCount++;
      tracker.record(s, nowMs);
      const dedupeKey = `${s.key}:${s.buyVenue}->${s.sellVenue}`;
      const first = !seenKeys.has(dedupeKey);
      seenKeys.add(dedupeKey);
      logSignal(log, s, first ? 'info' : 'debug');

      // Paper fills on first occurrence only to avoid re-executing the same
      // quote every scan. Repeated signals are counted for stats.
      if (!first) continue;
      const view = store.getView(s.key);
      if (!view) continue;
      const intent = crossVenueIntent(s, view);
      if (!intent) continue;

      const snapshot = executor.portfolio.snapshot(store.views());
      const dailyRealizedPnlUsd = snapshot.realizedPnlUsd.sub(dailyRealizedPnlBaseline);
      const riskState = riskStateFromSnapshot(snapshot, dailyRealizedPnlUsd);
      const riskResult = riskEngine.check(intent, riskState, nowMs);
      if (!riskResult.allowed) {
        riskRejectCount += 1;
        log.warn(
          {
            signalId: intent.signalId,
            reasons: riskResult.reasons,
          },
          'risk check denied intent',
        );
        continue;
      }

      const outcome = executor.execute(intent);
      if (outcome.status === 'executed') executedCount += 1;
      log.info(
        {
          signalId: intent.signalId,
          outcome: outcomeLabel(outcome),
          fills: outcome.status === 'executed' ? outcome.result.fills.length : 0,
        },
        'paper execution',
      );
      if (outcome.status === 'executed') {
        for (const fill of outcome.result.fills) logFill(log, fill);
      }
    }
  }, cfg.SCAN_INTERVAL_MS);

  const statsTimer = setInterval(() => {
    logger.info('trader stats', {
      instruments: store.views().length,
      signals: signalCount,
      executed: executedCount,
      riskRejects: riskRejectCount,
    });
    signalCount = 0;
    executedCount = 0;
    riskRejectCount = 0;
    seenKeys.clear();
  }, cfg.STATS_INTERVAL_MS);

  const reportTimer = setInterval(() => {
    const snap = executor.portfolio.snapshot(store.views());
    logger.info('paper portfolio summary', {
      openPositions: snap.openPositions,
      grossNotionalUsd: snap.grossNotionalUsd.toString(),
      realizedPnlUsd: snap.realizedPnlUsd.toString(),
      unrealizedPnlUsd: snap.unrealizedPnlUsd.toString(),
      feesPaidUsd: snap.feesPaidUsd.toString(),
      netPnlUsd: snap.netPnlUsd.toString(),
      perVenue: snap.perVenue.map((v) => ({ key: v.key, ...fmtExposure(v) })),
      perUnderlying: snap.perUnderlying.map((u) => ({ key: u.key, ...fmtExposure(u) })),
    });
  }, cfg.PAPER_REPORT_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(scanTimer);
    clearInterval(statsTimer);
    clearInterval(reportTimer);
    await Promise.all(running.map((c) => c.disconnect()));
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function fmtExposure(e: { notionalUsd: Decimal; pnlUsd: Decimal }) {
  return { notionalUsd: e.notionalUsd.toString(), pnlUsd: e.pnlUsd.toString() };
}

main().catch((err: unknown) => {
  console.error('trader fatal error', err);
  process.exit(1);
});
