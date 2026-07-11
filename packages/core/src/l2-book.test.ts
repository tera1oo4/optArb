import { describe, expect, it } from 'vitest';
import { dec } from './decimal.js';
import { L2Book } from './l2-book.js';

const lvl = (price: string, size: number) => ({ price: dec(price), size: dec(size) });

describe('L2Book', () => {
  it('replaces with snapshot and sorts sides', () => {
    const book = new L2Book();
    book.replace([lvl('100', 1), lvl('101', 2)], [lvl('103', 3), lvl('102', 4)]);
    const top = book.top(10);
    expect(top.bids.map((l) => l.price.toNumber())).toEqual([101, 100]);
    expect(top.asks.map((l) => l.price.toNumber())).toEqual([102, 103]);
  });

  it('applies deltas and deletes zero-size levels', () => {
    const book = new L2Book();
    book.replace([lvl('100', 1)], [lvl('102', 4)]);
    book.apply([lvl('100', 5), lvl('99', 2)], [lvl('102', 0)]);
    const top = book.top(10);
    expect(top.bids.map((l) => [l.price.toNumber(), l.size.toNumber()])).toEqual([
      [100, 5],
      [99, 2],
    ]);
    expect(top.asks).toHaveLength(0);
  });

  it('limits depth', () => {
    const book = new L2Book();
    book.replace([lvl('100', 1), lvl('101', 1), lvl('102', 1)], []);
    expect(book.top(2).bids.map((l) => l.price.toNumber())).toEqual([102, 101]);
    expect(book.levels).toBe(3);
  });
});
