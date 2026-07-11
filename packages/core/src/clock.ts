/**
 * All time goes through the Clock interface (ADR-0004): live clock in production,
 * virtual clock in replay/backtest. Code must never call Date.now() directly.
 */
export interface Clock {
  nowMs(): number;
}

export class LiveClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private current = 0;

  nowMs(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(deltaMs: number): void {
    this.current += deltaMs;
  }
}
