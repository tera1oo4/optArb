import { describe, expect, it } from 'vitest';
import type { Venue } from '@optarb/core';
import { Redis } from 'ioredis';
import type {
  BookSnapshot,
  MetricsSnapshot,
  RedisPortfolioSnapshot,
  VenueStatusSnapshot,
} from './redis-state-store.js';
import {
  IoRedisStateStore,
  NoOpRedisStateStore,
  createRedisStateStore,
} from './redis-state-store.js';

interface FakeRedisCommand {
  cmd: string;
  args: unknown[];
}

function fakeRedis(initialKillSwitch: string | null = null): {
  redis: Redis;
  commands: FakeRedisCommand[];
} {
  const commands: FakeRedisCommand[] = [];
  const redis = {
    async set(...args: unknown[]) {
      commands.push({ cmd: 'set', args });
    },
    async get(key: string) {
      commands.push({ cmd: 'get', args: [key] });
      return key === 'optarb:kill:switch' ? initialKillSwitch : '0';
    },
    async quit() {
      commands.push({ cmd: 'quit', args: [] });
    },
  } as unknown as Redis;
  return { redis, commands };
}

describe('createRedisStateStore', () => {
  it('returns NoOpRedisStateStore when REDIS_URL is unset', () => {
    const store = createRedisStateStore({});
    expect(store).toBeInstanceOf(NoOpRedisStateStore);
  });

  it('returns IoRedisStateStore when REDIS_URL is set', () => {
    const store = createRedisStateStore({ REDIS_URL: 'redis://localhost:6379' }, undefined, {
      killSwitchKey: 'custom:kill',
    });
    expect(store).toBeInstanceOf(IoRedisStateStore);
  });
});

describe('NoOpRedisStateStore', () => {
  it('returns false for kill switch and resolves all methods', async () => {
    const store = new NoOpRedisStateStore();
    await store.setKillSwitch(true);
    expect(await store.getKillSwitch()).toBe(false);
    await store.publishBookSnapshot('deribit', 'i1', {} as BookSnapshot);
    await store.publishPortfolioSnapshot({} as RedisPortfolioSnapshot);
    await store.publishMetrics({} as MetricsSnapshot);
    await store.publishVenueStatus('deribit', {} as VenueStatusSnapshot);
    await store.close();
  });
});

describe('IoRedisStateStore', () => {
  it('formats kill-switch key and writes active/inactive values', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis);

    await store.setKillSwitch(true);
    await store.setKillSwitch(false);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ cmd: 'set', args: ['optarb:kill:switch', '1'] });
    expect(commands[1]).toEqual({ cmd: 'set', args: ['optarb:kill:switch', '0'] });
  });

  it('reads kill switch state from Redis', async () => {
    const { redis, commands } = fakeRedis('1');
    const store = new IoRedisStateStore(redis);

    const active = await store.getKillSwitch();

    expect(active).toBe(true);
    expect(commands).toEqual([{ cmd: 'get', args: ['optarb:kill:switch'] }]);
  });

  it('uses custom kill-switch key when provided', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis, undefined, { killSwitchKey: 'custom:kill:key' });

    await store.setKillSwitch(true);
    await store.getKillSwitch();

    expect(commands[0]?.args[0]).toBe('custom:kill:key');
    expect(commands[1]?.args[0]).toBe('custom:kill:key');
  });

  it('publishes a book snapshot to the correct key with TTL', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis);
    const snapshot: BookSnapshot = {
      venue: 'deribit',
      instrumentId: 'deribit:BTC-26SEP26-100000-C',
      viewKey: 'BTC:CALL:2026-09-26:100000',
      bid: { priceUsd: '1500', sizeCoin: '1.5' },
      ask: { priceUsd: '1600', sizeCoin: '1.0' },
      markUsd: '1550',
      indexPriceUsd: '65000',
      tsMs: 1_000,
      recvMs: 1_001,
    };

    await store.publishBookSnapshot('deribit', 'deribit:BTC-26SEP26-100000-C', snapshot);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.cmd).toBe('set');
    expect(commands[0]?.args[0]).toBe('optarb:book:deribit:deribit:BTC-26SEP26-100000-C');
    expect(commands[0]?.args[2]).toBe('EX');
    expect(commands[0]?.args[3]).toBe(300);
    const payload = JSON.parse(commands[0]?.args[1] as string);
    expect(payload.bid).toEqual({ priceUsd: '1500', sizeCoin: '1.5' });
  });

  it('publishes portfolio snapshot to optarb:portfolio:snapshot', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis);
    const snapshot: RedisPortfolioSnapshot = {
      tsMs: 5_000,
      openPositions: 1,
      grossNotionalUsd: '1100',
      realizedPnlUsd: '50',
      unrealizedPnlUsd: '100',
      feesPaidUsd: '10',
      netPnlUsd: '140',
      perVenue: [{ key: 'okx', notionalUsd: '1100', pnlUsd: '140' }],
      perUnderlying: [{ key: 'BTC', notionalUsd: '1100', pnlUsd: '140' }],
      positions: [],
    };

    await store.publishPortfolioSnapshot(snapshot);

    expect(commands[0]?.cmd).toBe('set');
    expect(commands[0]?.args[0]).toBe('optarb:portfolio:snapshot');
    expect(commands[0]?.args[2]).toBe('EX');
    expect(commands[0]?.args[3]).toBe(3600);
  });

  it('publishes metrics to optarb:metrics', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis);
    const metrics: MetricsSnapshot = {
      tsMs: 6_000,
      signalsSeen: 10,
      riskRejects: 2,
      fillsCount: 3,
      viewsCount: 42,
    };

    await store.publishMetrics(metrics);

    expect(commands[0]?.cmd).toBe('set');
    expect(commands[0]?.args[0]).toBe('optarb:metrics');
    const payload = JSON.parse(commands[0]?.args[1] as string);
    expect(payload.signalsSeen).toBe(10);
    expect(payload.riskRejects).toBe(2);
    expect(payload.fillsCount).toBe(3);
  });

  it('publishes venue status to optarb:status:{venue}', async () => {
    const { redis, commands } = fakeRedis();
    const store = new IoRedisStateStore(redis);
    const status: VenueStatusSnapshot = {
      venue: 'deribit',
      state: 'connected',
      instrumentCount: 40,
      tsMs: 7_000,
    };

    await store.publishVenueStatus('deribit', status);

    expect(commands[0]?.cmd).toBe('set');
    expect(commands[0]?.args[0]).toBe('optarb:status:deribit');
    const payload = JSON.parse(commands[0]?.args[1] as string);
    expect(payload.instrumentCount).toBe(40);
  });

  it('returns false for getKillSwitch on error and logs it', async () => {
    const redis = {
      async get() {
        throw new Error('redis down');
      },
      async quit() {},
    } as unknown as Redis;
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta: meta ?? {} }),
    };
    const store = new IoRedisStateStore(redis, logger);

    const active = await store.getKillSwitch();

    expect(active).toBe(false);
    expect(logs.some((l) => l.msg === 'redis getKillSwitch failed')).toBe(true);
  });
});

const testRedisUrl = process.env.TEST_REDIS_URL;
const describeIfRedis = testRedisUrl ? describe : describe.skip;

describeIfRedis('IoRedisStateStore integration', () => {
  it('round-trips kill switch, portfolio and metrics', async () => {
    const redis = new Redis(testRedisUrl!, { lazyConnect: true });
    await redis.connect();
    const store = new IoRedisStateStore(redis);
    const uniqueKey = `optarb:test:${Date.now()}:kill`;

    try {
      await store.setKillSwitch(true);
      expect(await store.getKillSwitch()).toBe(true);
      await store.setKillSwitch(false);
      expect(await store.getKillSwitch()).toBe(false);

      await store.publishMetrics({
        tsMs: Date.now(),
        signalsSeen: 1,
        riskRejects: 0,
        fillsCount: 0,
      });
      const metricsRaw = await redis.get('optarb:metrics');
      expect(metricsRaw).not.toBeNull();
      const metrics = JSON.parse(metricsRaw!);
      expect(metrics.signalsSeen).toBe(1);
    } finally {
      await redis.del(uniqueKey);
      await store.close();
    }
  });
});
