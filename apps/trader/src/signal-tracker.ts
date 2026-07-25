import type { Decimal, Venue } from '@optarb/core';
import type { InstrumentView } from '@optarb/marketdata';
import type { CrossVenueSignal } from '@optarb/signals';

export interface SignalOutcome {
  signalId: string;
  key: string;
  buyVenue: Venue;
  sellVenue: Venue;
  entrySpreadBps: string;
  horizonMs: number;
  /** Spread at horizon in bps, or null if the required quotes disappeared */
  spreadBps: string | null;
}

interface TrackedSignal {
  signal: CrossVenueSignal;
  recordedMs: number;
  remainingHorizons: number[];
}

/**
 * In-memory hit-rate helper (ADR-0001): records the entry spread of a
 * cross-venue signal and later compares it with the spread at configured
 * horizons. No persistence — bounded by a max-size ring plus completion pruning.
 */
export class SignalTracker {
  private readonly tracked = new Map<string, TrackedSignal>();
  private readonly maxTracked: number;

  constructor(
    private readonly horizonsMs: number[],
    opts: { maxTracked?: number } = {},
  ) {
    this.maxTracked = opts.maxTracked ?? 5_000;
  }

  record(signal: CrossVenueSignal, nowMs: number): void {
    const key = this.signalKey(signal);
    if (this.tracked.has(key)) return;
    this.tracked.set(key, {
      signal,
      recordedMs: nowMs,
      remainingHorizons: [...this.horizonsMs],
    });
    if (this.tracked.size > this.maxTracked) {
      const first = this.tracked.keys().next().value;
      if (first !== undefined) this.tracked.delete(first);
    }
  }

  update(views: InstrumentView[], nowMs: number): SignalOutcome[] {
    const byKey = new Map<string, InstrumentView>();
    for (const v of views) byKey.set(v.key, v);

    const outcomes: SignalOutcome[] = [];
    for (const [key, tracked] of this.tracked) {
      const elapsed = nowMs - tracked.recordedMs;
      const ready = tracked.remainingHorizons.filter((h) => elapsed >= h);
      if (ready.length === 0) continue;

      const view = byKey.get(tracked.signal.key);
      const currentSpread = view === undefined ? null : this.currentSpread(view, tracked.signal);
      for (const horizonMs of ready) {
        outcomes.push({
          signalId: key,
          key: tracked.signal.key,
          buyVenue: tracked.signal.buyVenue,
          sellVenue: tracked.signal.sellVenue,
          entrySpreadBps: tracked.signal.spreadBps.toFixed(2),
          horizonMs,
          spreadBps: currentSpread?.toFixed(2) ?? null,
        });
      }
      tracked.remainingHorizons = tracked.remainingHorizons.filter((h) => !ready.includes(h));
      if (tracked.remainingHorizons.length === 0) this.tracked.delete(key);
    }
    return outcomes;
  }

  stats(): { active: number; totalHorizons: number } {
    let totalHorizons = 0;
    for (const t of this.tracked.values()) totalHorizons += t.remainingHorizons.length;
    return { active: this.tracked.size, totalHorizons };
  }

  private signalKey(signal: CrossVenueSignal): string {
    return `${signal.kind}:${signal.key}:${signal.buyVenue}->${signal.sellVenue}:${signal.tsMs}`;
  }

  private currentSpread(view: InstrumentView, signal: CrossVenueSignal): Decimal | null {
    const buy = view.quotes.get(signal.buyVenue);
    const sell = view.quotes.get(signal.sellVenue);
    if (!buy || !sell) return null;
    if (buy.askUsd === null || sell.bidUsd === null) return null;
    if (buy.askUsd.isZero()) return null;
    return sell.bidUsd.sub(buy.askUsd).div(buy.askUsd).mul(10_000);
  }
}
