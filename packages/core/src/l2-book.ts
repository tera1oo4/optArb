import { dec, type Decimal } from './decimal.js';
import type { PriceLevel } from './model.js';

/**
 * Generic L2 order book shared by venue connectors.
 * Supports full replace (snapshot channels) and delta apply (size 0 = delete).
 */
export class L2Book {
  private readonly bids = new Map<string, Decimal>();
  private readonly asks = new Map<string, Decimal>();
  private bidsDirty = true;
  private asksDirty = true;
  private cachedBids: PriceLevel[] = [];
  private cachedAsks: PriceLevel[] = [];

  replace(bids: PriceLevel[], asks: PriceLevel[]): void {
    this.bids.clear();
    this.asks.clear();
    this.bidsDirty = true;
    this.asksDirty = true;
    for (const l of bids) this.applyOne(this.bids, l);
    for (const l of asks) this.applyOne(this.asks, l);
  }

  apply(bids: PriceLevel[], asks: PriceLevel[]): void {
    if (bids.length > 0) this.bidsDirty = true;
    if (asks.length > 0) this.asksDirty = true;
    for (const l of bids) this.applyOne(this.bids, l);
    for (const l of asks) this.applyOne(this.asks, l);
  }

  top(depth: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    return {
      bids: this.topSide('bids', this.bids, depth, 'desc'),
      asks: this.topSide('asks', this.asks, depth, 'asc'),
    };
  }

  get levels(): number {
    return this.bids.size + this.asks.size;
  }

  private applyOne(side: Map<string, Decimal>, level: PriceLevel): void {
    const key = level.price.toString();
    if (level.size.isZero()) side.delete(key);
    else side.set(key, level.size);
  }

  private topSide(
    sideName: 'bids' | 'asks',
    side: Map<string, Decimal>,
    depth: number,
    order: 'asc' | 'desc',
  ): PriceLevel[] {
    const dirty = sideName === 'bids' ? this.bidsDirty : this.asksDirty;
    const cache = sideName === 'bids' ? this.cachedBids : this.cachedAsks;
    if (!dirty) return cache.slice(0, depth);

    const levels: PriceLevel[] = [];
    for (const [price, size] of side) levels.push({ price: dec(price), size });
    levels.sort((a, b) => (order === 'asc' ? a.price.cmp(b.price) : b.price.cmp(a.price)));
    const top = levels.slice(0, depth);

    if (sideName === 'bids') {
      this.cachedBids = levels;
      this.bidsDirty = false;
    } else {
      this.cachedAsks = levels;
      this.asksDirty = false;
    }
    return top;
  }
}
