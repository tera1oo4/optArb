import { describe, expect, it } from 'vitest';
import { createRuntimeKillSwitch, RuntimeKillSwitch } from './runtime-kill-switch.js';

function throwingStore(): import('@optarb/persistence').RedisStateStore {
  return {
    setKillSwitch: async () => {},
    getKillSwitch: async () => {
      throw new Error('redis down');
    },
    publishBookSnapshot: async () => {},
    publishPortfolioSnapshot: async () => {},
    publishMetrics: async () => {},
    publishVenueStatus: async () => {},
    close: async () => {},
  };
}

describe('RuntimeKillSwitch', () => {
  it('reads the kill-switch from Redis when configured', async () => {
    const store = {
      getKillSwitch: async () => true,
    } as unknown as import('@optarb/persistence').RedisStateStore;
    const ks = createRuntimeKillSwitch({ REDIS_URL: 'redis://localhost' }, store);
    expect(await ks.isActive()).toBe(true);
  });

  it('falls back to the env value when Redis is not configured', async () => {
    const store = throwingStore();
    const ks = createRuntimeKillSwitch({ RISK_KILL_SWITCH: true }, store);
    expect(await ks.isActive()).toBe(true);
  });

  it('fails closed when Redis read throws', async () => {
    const logs: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => logs.push(msg),
    };
    const ks = new RuntimeKillSwitch(throwingStore(), false, true, logger);
    expect(await ks.isActive()).toBe(true);
    expect(logs.some((m) => m.includes('kill-switch read failed'))).toBe(true);
  });
});
