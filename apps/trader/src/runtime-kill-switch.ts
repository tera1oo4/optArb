import type { Logger, Venue } from '@optarb/core';
import type { RedisStateStore } from '@optarb/persistence';

/**
 * Runtime kill switch interface. Global scope is required for M8; the optional
 * `venue` in `scope` keeps the door open for per-venue kill switches without
 * breaking callers.
 */
export interface KillSwitch {
  isActive(scope?: { venue?: Venue }): Promise<boolean>;
}

/**
 * Poll-based runtime kill switch.
 *
 * - When Redis is configured, reads `optarb:kill:switch` fresh on every scan.
 * - When Redis is not configured, falls back to the static `RISK_KILL_SWITCH`
 *   env value so the risk engine can still be locked down at process start.
 */
export class RuntimeKillSwitch implements KillSwitch {
  constructor(
    private readonly store: RedisStateStore,
    private readonly envActive: boolean,
    private readonly hasRedis: boolean,
    private readonly logger?: Logger,
  ) {}

  async isActive(scope?: { venue?: Venue }): Promise<boolean> {
    try {
      if (scope?.venue) {
        // Per-venue kill switch is reserved for a future milestone.
        return false;
      }
      if (this.hasRedis) {
        return await this.store.getKillSwitch();
      }
      return this.envActive;
    } catch (err) {
      // Fail-closed: any error reading the kill switch blocks trading.
      this.logger?.error('kill-switch read failed; treating as active', { err: String(err) });
      return true;
    }
  }
}

export function createRuntimeKillSwitch(
  env: { REDIS_URL?: string; RISK_KILL_SWITCH?: string | boolean },
  store: RedisStateStore,
  logger?: Logger,
): RuntimeKillSwitch {
  const hasRedis = !!env.REDIS_URL;
  const envActive =
    typeof env.RISK_KILL_SWITCH === 'boolean'
      ? env.RISK_KILL_SWITCH
      : env.RISK_KILL_SWITCH === 'true';
  return new RuntimeKillSwitch(store, envActive, hasRedis, logger);
}
