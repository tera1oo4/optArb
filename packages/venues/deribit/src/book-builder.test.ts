import { describe, expect, it } from 'vitest';
import { dec } from '@optarb/core';
import { BookBuilder, SequenceGapError, type BookMessage } from './book-builder.js';

function msg(partial: Partial<BookMessage> & Pick<BookMessage, 'type' | 'changeId'>): BookMessage {
  return {
    instrument: 'BTC-28JUN24-70000-C',
    prevChangeId: null,
    bids: [],
    asks: [],
    ...partial,
  };
}

describe('BookBuilder', () => {
  it('builds top-of-book from snapshot', () => {
    const book = new BookBuilder('BTC-28JUN24-70000-C');
    book.apply(
      msg({
        type: 'snapshot',
        changeId: 100,
        bids: [
          { action: 'new', price: dec('0.012'), amount: dec(5) },
          { action: 'new', price: dec('0.013'), amount: dec(3) },
        ],
        asks: [{ action: 'new', price: dec('0.014'), amount: dec(2) }],
      }),
    );
    const top = book.top(10);
    expect(top.bids.map((l) => l.price.toString())).toEqual(['0.013', '0.012']);
    expect(top.asks.map((l) => l.price.toString())).toEqual(['0.014']);
    expect(book.sequence).toBe(100);
  });

  it('applies changes, updates and deletes in sequence', () => {
    const book = new BookBuilder('BTC-28JUN24-70000-C');
    book.apply(
      msg({
        type: 'snapshot',
        changeId: 100,
        bids: [{ action: 'new', price: dec('0.012'), amount: dec(5) }],
      }),
    );
    book.apply(
      msg({
        type: 'change',
        changeId: 101,
        prevChangeId: 100,
        bids: [{ action: 'change', price: dec('0.012'), amount: dec(9) }],
        asks: [{ action: 'new', price: dec('0.015'), amount: dec(1) }],
      }),
    );
    book.apply(
      msg({
        type: 'change',
        changeId: 102,
        prevChangeId: 101,
        bids: [{ action: 'delete', price: dec('0.012'), amount: dec(0) }],
      }),
    );
    const top = book.top(10);
    expect(top.bids).toHaveLength(0);
    expect(top.asks[0]!.size.toNumber()).toBe(1);
  });

  it('throws SequenceGapError on broken sequence', () => {
    const book = new BookBuilder('BTC-28JUN24-70000-C');
    book.apply(msg({ type: 'snapshot', changeId: 100 }));
    expect(() => book.apply(msg({ type: 'change', changeId: 105, prevChangeId: 104 }))).toThrow(
      SequenceGapError,
    );
  });

  it('limits depth when returning top levels', () => {
    const book = new BookBuilder('BTC-28JUN24-70000-C');
    book.apply(
      msg({
        type: 'snapshot',
        changeId: 1,
        bids: [1, 2, 3].map((i) => ({
          action: 'new' as const,
          price: dec(`0.01${i}`),
          amount: dec(i),
        })),
      }),
    );
    expect(book.top(2).bids).toHaveLength(2);
  });
});
