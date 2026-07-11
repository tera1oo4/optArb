import 'dotenv/config';
import pino from 'pino';
import { dec, InMemoryEventBus, LiveClock, nullCapture, type Logger } from '@optarb/core';
import { MarketDataStore } from '@optarb/marketdata';
import { CrossVenueDetector, type CrossVenueSignal } from '@optarb/signals';
import { createVenueConnector, type VenueRuntimeConfigs } from '@optarb/venues';
import { loadConfig } from './config.js';

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
  };
}

/**
 * Paper trader (ADR-0006): consumes live market data, maintains the consolidated
 * USD view and emits cross-venue arb signals. NEVER sends orders — paper only.
 * Live execution will require LIVE_TRADING=true + operator confirmation.
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
  const seenKeys = new Set<string>();
  const scanTimer = setInterval(() => {
    const signals = detector.detect(store.views(), clock.nowMs());
    for (const s of signals) {
      signalCount++;
      // Log first occurrence per instrument+direction loudly, repeats at debug
      const dedupeKey = `${s.key}:${s.buyVenue}->${s.sellVenue}`;
      const first = !seenKeys.has(dedupeKey);
      seenKeys.add(dedupeKey);
      logSignal(log, s, first ? 'info' : 'debug');
    }
  }, cfg.SCAN_INTERVAL_MS);

  const statsTimer = setInterval(() => {
    logger.info('trader stats', { instruments: store.views().length, signals: signalCount });
    signalCount = 0;
    seenKeys.clear();
  }, cfg.STATS_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(scanTimer);
    clearInterval(statsTimer);
    await Promise.all(running.map((c) => c.disconnect()));
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
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

main().catch((err: unknown) => {
  console.error('trader fatal error', err);
  process.exit(1);
});
