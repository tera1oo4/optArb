import 'dotenv/config';
import pino from 'pino';
import { InMemoryEventBus, LiveClock, type Logger } from '@optarb/core';
import { JsonlCaptureSink } from '@optarb/persistence';
import { createVenueConnector, type VenueRuntimeConfigs } from '@optarb/venues';
import { loadConfig, type CollectorConfig } from './config.js';

function toLogger(log: pino.Logger): Logger {
  return {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}

export function venueConfigs(cfg: CollectorConfig): VenueRuntimeConfigs {
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });
  const logger = toLogger(log);

  const bus = new InMemoryEventBus();
  const clock = new LiveClock();
  const capture = new JsonlCaptureSink({ dir: cfg.CAPTURE_DIR });
  const configs = venueConfigs(cfg);
  const connectors = cfg.VENUES.map((v) =>
    createVenueConnector(v, configs, { bus, clock, capture, logger }),
  );

  const counters: Record<string, { book: number; trade: number; ticker: number }> = {};
  for (const v of cfg.VENUES) counters[v] = { book: 0, trade: 0, ticker: 0 };
  bus.on('market.book', (e) => counters[e.venue]!.book++);
  bus.on('market.trade', (e) => counters[e.venue]!.trade++);
  bus.on('market.ticker', (e) => counters[e.venue]!.ticker++);
  bus.on('connector.status', (s) => logger.info('connector status', { ...s }));

  const running: typeof connectors = [];
  for (const connector of connectors) {
    try {
      const instruments = await connector.loadInstruments();
      logger.info('instruments loaded', {
        venue: connector.venue,
        count: instruments.length,
        sample: instruments.slice(0, 3).map((i) => i.venueSymbol),
      });
      await connector.connect();
      await connector.subscribe(instruments);
      running.push(connector);
    } catch (err) {
      logger.error('venue startup failed, continuing without it', {
        venue: connector.venue,
        err: String(err),
      });
    }
  }
  if (running.length === 0) throw new Error('no venue started — nothing to capture');

  const statsTimer = setInterval(() => {
    logger.info('market data stats', { ...counters });
    for (const v of cfg.VENUES) counters[v] = { book: 0, trade: 0, ticker: 0 };
  }, cfg.STATS_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(statsTimer);
    await Promise.all(running.map((c) => c.disconnect()));
    await capture.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('collector fatal error', err);
  process.exit(1);
});
