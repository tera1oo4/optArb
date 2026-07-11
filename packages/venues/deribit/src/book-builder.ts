import { dec, type Decimal, type PriceLevel } from '@optarb/core';

export type BookAction = 'new' | 'change' | 'delete';

export interface BookDelta {
  action: BookAction;
  price: Decimal;
  amount: Decimal;
}

export interface BookMessage {
  type: 'snapshot' | 'change';
  instrument: string;
  changeId: number;
  prevChangeId: number | null;
  bids: BookDelta[];
  asks: BookDelta[];
}

export class SequenceGapError extends Error {
  readonly instrument: string;
  readonly expected: number | null;
  readonly got: number | null;

  constructor(instrument: string, expected: number | null, got: number | null) {
    super(
      `order book sequence gap on ${instrument}: expected prev_change_id=${expected}, got=${got}`,
    );
    this.name = 'SequenceGapError';
    this.instrument = instrument;
    this.expected = expected;
    this.got = got;
  }
}

/**
 * Maintains one instrument's order book from Deribit incremental book messages.
 * Enforces prev_change_id sequencing (ADR-0003): gaps throw SequenceGapError so the
 * caller can resync — a silently diverged book produces false arb signals.
 */
export class BookBuilder {
  private readonly bids = new Map<string, Decimal>();
  private readonly asks = new Map<string, Decimal>();
  private changeId: number | null = null;

  constructor(readonly instrument: string) {}

  get sequence(): number | null {
    return this.changeId;
  }

  apply(msg: BookMessage): void {
    if (msg.type === 'change' && this.changeId !== null && msg.prevChangeId !== this.changeId) {
      throw new SequenceGapError(this.instrument, this.changeId, msg.prevChangeId);
    }
    if (msg.type === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
    }
    for (const d of msg.bids) this.applyDelta(this.bids, d);
    for (const d of msg.asks) this.applyDelta(this.asks, d);
    this.changeId = msg.changeId;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.changeId = null;
  }

  top(depth: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    return {
      bids: this.topSide(this.bids, depth, 'desc'),
      asks: this.topSide(this.asks, depth, 'asc'),
    };
  }

  private applyDelta(side: Map<string, Decimal>, d: BookDelta): void {
    const key = d.price.toString();
    if (d.action === 'delete' || d.amount.isZero()) side.delete(key);
    else side.set(key, d.amount);
  }

  private topSide(side: Map<string, Decimal>, depth: number, order: 'asc' | 'desc'): PriceLevel[] {
    const levels: PriceLevel[] = [];
    for (const [price, size] of side) levels.push({ price: dec(price), size });
    levels.sort((a, b) => (order === 'asc' ? a.price.cmp(b.price) : b.price.cmp(a.price)));
    return levels.slice(0, depth);
  }
}
