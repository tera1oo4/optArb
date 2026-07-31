import 'dotenv/config';
import pino from 'pino';
import {
  createHealthServer,
  HealthRegistry,
  InMemoryEventBus,
  LiveClock,
  type ConnectorStatus,
  type Logger,
  type Venue,
} from '@optarb/core';
import type { Server } from 'node:http';
import {
  createRedisStateStore,
  JsonlCaptureSink,
  RotatingJsonlCaptureSink,
} from '@optarb/persistence';
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
    polymarket: {
      gammaUrl: cfg.POLYMARKET_GAMMA_URL,
      wsUrl: cfg.POLYMARKET_WS_URL,
      underlyings: [...cfg.POLYMARKET_UNDERLYINGS],
      maxMarkets: cfg.POLYMARKET_MAX_MARKETS,
      bookDepth: cfg.POLYMARKET_BOOK_DEPTH,
    },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });
  const logger = toLogger(log);

  const bus = new InMemoryEventBus();
  const clock = new LiveClock();
  const capture = cfg.CAPTURE_ROTATE_HOURLY
    ? new RotatingJsonlCaptureSink({
        dir: cfg.CAPTURE_DIR,
        clock,
        retentionHours: cfg.CAPTURE_RETENTION_HOURS,
        logger,
      })
    : new JsonlCaptureSink({ dir: cfg.CAPTURE_DIR });
  const redisStore = createRedisStateStore({ REDIS_URL: cfg.REDIS_URL }, logger);
  const configs = venueConfigs(cfg);
  const connectors = cfg.VENUES.map((v) =>
    createVenueConnector(v, configs, { bus, clock, capture, logger }),
  );

  const counters: Record<string, { book: number; trade: number; ticker: number }> = {};
  for (const v of cfg.VENUES) counters[v] = { book: 0, trade: 0, ticker: 0 };
  const statuses = new Map<Venue, ConnectorStatus>();
  const instrumentCounts = new Map<Venue, number>();
  const lastMessageTs = new Map<Venue, number>();
  let lastCaptureTs = 0;
  const updateLastMessageTs = (venue: Venue, tsMs: number) => {
    lastMessageTs.set(venue, tsMs);
    lastCaptureTs = tsMs;
  };
  bus.on('market.book', (e) => {
    counters[e.venue]!.book++;
    updateLastMessageTs(e.venue, e.recvMs);
  });
  bus.on('market.trade', (e) => {
    counters[e.venue]!.trade++;
    updateLastMessageTs(e.venue, e.recvMs);
  });
  bus.on('market.ticker', (e) => {
    counters[e.venue]!.ticker++;
    updateLastMessageTs(e.venue, e.recvMs);
  });
  bus.on('connector.status', (s) => {
    statuses.set(s.venue, s);
    logger.info('connector status', { ...s });
  });

  const healthRegistry = new HealthRegistry();
  const VENUE_STALE_MS = 30_000;
  const SCAN_STALE_MS = 60_000;
  for (const venue of cfg.VENUES) {
    healthRegistry.register(
      `venue:${venue}`,
      () => {
        const status = statuses.get(venue);
        const lastTs = lastMessageTs.get(venue) ?? 0;
        const nowMs = clock.nowMs();
        if (!status || status.state !== 'connected') {
          return { healthy: false, message: `state=${status?.state ?? 'unknown'}` };
        }
        if (nowMs - lastTs > VENUE_STALE_MS) {
          return { healthy: false, message: `no message for ${nowMs - lastTs}ms` };
        }
        return { healthy: true };
      },
      { critical: true },
    );
  }
  healthRegistry.register('kill-switch', async () => {
    if (!cfg.REDIS_URL) return { healthy: true, message: 'disabled' };
    const active = await redisStore.getKillSwitch();
    return active ? { healthy: false, message: 'active' } : { healthy: true };
  });
  healthRegistry.register('postgres', () => ({ healthy: true, message: 'disabled' }));
  healthRegistry.register('last-scan', () => {
    const nowMs = clock.nowMs();
    const stale = nowMs - lastCaptureTs > SCAN_STALE_MS;
    return {
      healthy: !stale,
      message: stale ? `no capture for ${nowMs - lastCaptureTs}ms` : 'recent',
    };
  });

  let healthServer: Server | undefined;
  if (cfg.HEALTH_ENABLED) {
    try {
      healthServer = await createHealthServer(healthRegistry, cfg.HEALTH_PORT);
      logger.info('health server listening', { port: cfg.HEALTH_PORT });
    } catch (err) {
      logger.error('health server failed to start', { err: String(err) });
    }
  }

  const running: typeof connectors = [];
  for (const connector of connectors) {
    try {
      const instruments = await connector.loadInstruments();
      instrumentCounts.set(connector.venue, instruments.length);
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
    const nowMs = clock.nowMs();
    logger.info('market data stats', { ...counters });
    for (const v of cfg.VENUES) counters[v] = { book: 0, trade: 0, ticker: 0 };

    for (const venue of cfg.VENUES) {
      const status = statuses.get(venue);
      if (!status) continue;
      void redisStore
        .publishVenueStatus(venue, {
          venue,
          state: status.state,
          instrumentCount: instrumentCounts.get(venue) ?? 0,
          tsMs: nowMs,
        })
        .catch(() => {});
    }
  }, cfg.STATS_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(statsTimer);
    await Promise.all(running.map((c) => c.disconnect()));
    await capture.close();
    await redisStore.close();
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('collector fatal error', err);
  process.exit(1);
});
