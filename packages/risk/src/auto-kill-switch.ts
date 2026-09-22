import type { Clock, Logger, Venue } from '@optarb/core';
import type { RiskConfig } from './config.js';

export interface AutoKillSwitchConfig {
  heartbeatIdleMs: number;
  sequenceGapThreshold: number;
  sequenceGapWindowMs: number;
  rejectThreshold: number;
  rejectWindowMs: number;
}

export function autoKillSwitchConfigFromRisk(cfg: RiskConfig): AutoKillSwitchConfig {
  return {
    heartbeatIdleMs: cfg.RISK_AUTO_KILL_HEARTBEAT_IDLE_MS,
    sequenceGapThreshold: cfg.RISK_AUTO_KILL_SEQUENCE_GAPS,
    sequenceGapWindowMs: cfg.RISK_AUTO_KILL_SEQUENCE_WINDOW_MS,
    rejectThreshold: cfg.RISK_AUTO_KILL_REJECT_COUNT,
    rejectWindowMs: cfg.RISK_AUTO_KILL_REJECT_WINDOW_MS,
  };
}

export interface AutoKillEvaluation {
  active: boolean;
  reasons: string[];
}

/**
 * Latching auto kill-switch (ADR-0006/ADR-0007).
 *
 * Tripwires:
 * - heartbeat loss: no market message from a known venue for heartbeatIdleMs
 * - sequence-gap burst: ≥ threshold book sequence gaps inside the window
 * - reject spike: ≥ threshold exchange rejects inside the window
 *
 * The switch LATCHES: once tripped it stays active until an operator calls
 * reset(). A flapping feed must never silently re-arm trading. All timestamps
 * flow through the injected Clock so replay/backtest stays deterministic.
 */
export class AutoKillSwitch {
  private readonly lastMessageTs = new Map<Venue, number>();
  private readonly gapTimestamps = new Map<Venue, number[]>();
  private readonly rejectTimestamps = new Map<Venue, number[]>();
  private latched = false;
  private latchReasons: string[] = [];

  constructor(
    private readonly config: AutoKillSwitchConfig,
    private readonly clock: Clock,
    private readonly logger?: Logger,
  ) {}

  /** A market message (book/ticker/trade) was received from a venue. */
  recordMessage(venue: Venue, tsMs: number): void {
    this.lastMessageTs.set(venue, tsMs);
  }

  /** A book sequence gap was detected on a venue (feed resynced). */
  recordSequenceGap(venue: Venue, tsMs: number): void {
    const ts = this.prune(
      this.gapTimestamps.get(venue) ?? [],
      tsMs,
      this.config.sequenceGapWindowMs,
    );
    ts.push(tsMs);
    this.gapTimestamps.set(venue, ts);
    if (ts.length >= this.config.sequenceGapThreshold) {
      this.trip(
        `sequence-gap burst on ${venue}: ${ts.length} gaps in ${this.config.sequenceGapWindowMs}ms`,
      );
    }
  }

  /** An exchange rejected (or failed) an order on a venue. */
  recordReject(venue: Venue, tsMs: number): void {
    const ts = this.prune(this.rejectTimestamps.get(venue) ?? [], tsMs, this.config.rejectWindowMs);
    ts.push(tsMs);
    this.rejectTimestamps.set(venue, ts);
    if (ts.length >= this.config.rejectThreshold) {
      this.trip(
        `reject spike on ${venue}: ${ts.length} rejects in ${this.config.rejectWindowMs}ms`,
      );
    }
  }

  /**
   * Evaluate time-based tripwires (heartbeat loss) and return the current
   * state. Call once per scan loop; event-driven tripwires latch immediately
   * in recordSequenceGap/recordReject.
   */
  evaluate(nowMs?: number): AutoKillEvaluation {
    const now = nowMs ?? this.clock.nowMs();
    if (!this.latched) {
      for (const [venue, lastTs] of this.lastMessageTs) {
        if (now - lastTs >= this.config.heartbeatIdleMs) {
          this.trip(`heartbeat loss on ${venue}: no message for ${now - lastTs}ms`);
          break;
        }
      }
    }
    return { active: this.latched, reasons: [...this.latchReasons] };
  }

  isActive(): boolean {
    return this.latched;
  }

  /** Operator-only reset after the incident is reviewed. */
  reset(): void {
    this.latched = false;
    this.latchReasons = [];
    this.gapTimestamps.clear();
    this.rejectTimestamps.clear();
  }

  private trip(reason: string): void {
    if (this.latched) {
      this.latchReasons.push(reason);
      return;
    }
    this.latched = true;
    this.latchReasons = [reason];
    this.logger?.error('auto kill-switch TRIPPED', { reason });
  }

  private prune(ts: number[], nowMs: number, windowMs: number): number[] {
    const cutoff = nowMs - windowMs;
    return ts.filter((t) => t >= cutoff);
  }
}
