import type { Logger, Venue } from '@optarb/core';
import { noopLogger } from '@optarb/core';
import { Redis } from 'ioredis';

/**
 * Normalized top-of-book snapshot published to Redis (ADR-0005).
 * Decimal values are serialized as strings to avoid float rounding.
 */
export interface BookSnapshot {
  venue: Venue;
  instrumentId: string;
  viewKey: string;
  bid: { priceUsd: string; sizeCoin: string } | null;
  ask: { priceUsd: string; sizeCoin: string } | null;
  markUsd: string | null;
  indexPriceUsd: string | null;
  tsMs: number;
  recvMs: number;
}

/** Portfolio summary serialized for Redis hot state. */
export interface RedisPortfolioSnapshot {
  tsMs: number;
  openPositions: number;
  grossNotionalUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;
  feesPaidUsd: string;
  netPnlUsd: string;
  perVenue: Array<{ key: string; notionalUsd: string; pnlUsd: string }>;
  perUnderlying: Array<{ key: string; notionalUsd: string; pnlUsd: string }>;
  positions: Array<{
    venue: Venue;
    instrumentId: string;
    viewKey: string;
    underlying: string;
    qty: string;
    avgEntryUsd: string;
    markUsd: string;
    notionalUsd: string;
    unrealizedPnlUsd: string;
    realizedPnlUsd: string;
    feesPaidUsd: string;
  }>;
}

/** Trader operational counters published to Redis. */
export interface MetricsSnapshot {
  tsMs: number;
  signalsSeen: number;
  riskRejects: number;
  fillsCount: number;
  viewsCount?: number;
  digitalSignalsSeen?: number;
  yesNoSignalsSeen?: number;
}

/** Venue connectivity and discovery summary published by the collector. */
export interface VenueStatusSnapshot {
  venue: Venue;
  state: string;
  instrumentCount: number;
  tsMs: number;
}

/**
 * Hot-state store backed by Redis (ADR-0005).
 * Implementations must be safe to call from the main loop: errors are logged
 * and swallowed for publish operations so a Redis outage cannot crash trading.
 */
export interface RedisStateStore {
  /** Activate/deactivate the global kill switch. */
  setKillSwitch(active: boolean): Promise<void>;
  /** Read the global kill switch state. Returns false on Redis errors. */
  getKillSwitch(): Promise<boolean>;
  /** Publish a top-of-book snapshot for a single instrument. */
  publishBookSnapshot(venue: Venue, instrumentId: string, snapshot: BookSnapshot): Promise<void>;
  /** Publish the latest portfolio summary. */
  publishPortfolioSnapshot(snapshot: RedisPortfolioSnapshot): Promise<void>;
  /** Publish operational counters. */
  publishMetrics(metrics: MetricsSnapshot): Promise<void>;
  /** Publish venue connectivity/discovery status (collector). */
  publishVenueStatus(venue: Venue, status: VenueStatusSnapshot): Promise<void>;
  /** Close the underlying connection. */
  close(): Promise<void>;
}

export interface RedisStateStoreOptions {
  /** Redis key for the global kill switch; default is `optarb:kill:switch`. */
  killSwitchKey?: string;
}

const DEFAULT_KILL_SWITCH_KEY = 'optarb:kill:switch';
const BOOK_TTL_SECONDS = 300;
const PORTFOLIO_TTL_SECONDS = 3_600;
const METRICS_TTL_SECONDS = 3_600;
const STATUS_TTL_SECONDS = 300;

export class IoRedisStateStore implements RedisStateStore {
  private readonly killSwitchKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger = noopLogger,
    options?: RedisStateStoreOptions,
  ) {
    this.killSwitchKey = options?.killSwitchKey ?? DEFAULT_KILL_SWITCH_KEY;
  }

  async setKillSwitch(active: boolean): Promise<void> {
    await this.redis.set(this.killSwitchKey, active ? '1' : '0');
  }

  async getKillSwitch(): Promise<boolean> {
    try {
      const value = await this.redis.get(this.killSwitchKey);
      return value === '1';
    } catch (err) {
      this.logger.error('redis getKillSwitch failed', { err: String(err) });
      return false;
    }
  }

  async publishBookSnapshot(
    venue: Venue,
    instrumentId: string,
    snapshot: BookSnapshot,
  ): Promise<void> {
    const key = `optarb:book:${venue}:${instrumentId}`;
    await this.safeSet(key, JSON.stringify(snapshot), BOOK_TTL_SECONDS);
  }

  async publishPortfolioSnapshot(snapshot: RedisPortfolioSnapshot): Promise<void> {
    await this.safeSet(
      'optarb:portfolio:snapshot',
      JSON.stringify(snapshot),
      PORTFOLIO_TTL_SECONDS,
    );
  }

  async publishMetrics(metrics: MetricsSnapshot): Promise<void> {
    await this.safeSet('optarb:metrics', JSON.stringify(metrics), METRICS_TTL_SECONDS);
  }

  async publishVenueStatus(venue: Venue, status: VenueStatusSnapshot): Promise<void> {
    const key = `optarb:status:${venue}`;
    await this.safeSet(key, JSON.stringify(status), STATUS_TTL_SECONDS);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private async safeSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.error('redis publish failed', { key, err: String(err) });
    }
  }
}

export class NoOpRedisStateStore implements RedisStateStore {
  async setKillSwitch(_active: boolean): Promise<void> {}

  async getKillSwitch(): Promise<boolean> {
    return false;
  }

  async publishBookSnapshot(
    _venue: Venue,
    _instrumentId: string,
    _snapshot: BookSnapshot,
  ): Promise<void> {}

  async publishPortfolioSnapshot(_snapshot: RedisPortfolioSnapshot): Promise<void> {}

  async publishMetrics(_metrics: MetricsSnapshot): Promise<void> {}

  async publishVenueStatus(_venue: Venue, _status: VenueStatusSnapshot): Promise<void> {}

  async close(): Promise<void> {}
}

export function createRedisStateStore(
  env: { REDIS_URL?: string },
  logger?: Logger,
  options?: RedisStateStoreOptions,
): RedisStateStore {
  if (env.REDIS_URL) {
    return new IoRedisStateStore(new Redis(env.REDIS_URL, { lazyConnect: true }), logger, options);
  }
  return new NoOpRedisStateStore();
}
