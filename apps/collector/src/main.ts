import 'dotenv/config';
import pino from 'pino';
import { InMemoryEventBus, LiveClock, type Logger } from '@optarb/core';
import { JsonlCaptureSink } from '@optarb/persistence';
import { DeribitConnector } from '@optarb/venue-deribit';
import { loadConfig } from './config.js';

function toLogger(log: pino.Logger): Logger {
  return {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });
  const logger = toLogger(log);

  const bus = new InMemoryEventBus();
  const clock = new LiveClock();
  const capture = new JsonlCaptureSink({ dir: cfg.CAPTURE_DIR });
  const connector = new DeribitConnector(
    {
      wsUrl: cfg.DERIBIT_WS_URL,
      restUrl: cfg.DERIBIT_REST_URL,
      currency: cfg.DERIBIT_CURRENCY,
      maxInstruments: cfg.DERIBIT_MAX_INSTRUMENTS,
      bookDepth: cfg.DERIBIT_BOOK_DEPTH,
    },
    { bus, clock, capture, logger },
  );

  const counters = { book: 0, trade: 0, ticker: 0 };
  bus.on('market.book', () => counters.book++);
  bus.on('market.trade', () => counters.trade++);
  bus.on('market.ticker', () => counters.ticker++);
  bus.on('connector.status', (s) => logger.info('connector status', { ...s }));

  const instruments = await connector.loadInstruments();
  logger.info('instruments loaded', {
    count: instruments.length,
    sample: instruments.slice(0, 3).map((i) => i.venueSymbol),
  });

  await connector.connect();
  await connector.subscribe(instruments);

  const statsTimer = setInterval(() => {
    logger.info('market data stats', { ...counters });
    counters.book = 0;
    counters.trade = 0;
    counters.ticker = 0;
  }, cfg.STATS_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(statsTimer);
    await connector.disconnect();
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
