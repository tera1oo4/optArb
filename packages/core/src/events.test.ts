import { describe, expect, it } from 'vitest';
import { dec } from './decimal.js';
import { emitAll, InMemoryEventBus } from './events.js';
import type { BookUpdate } from './model.js';

function makeBook(seq: number): BookUpdate {
  return {
    venue: 'deribit',
    instrumentId: 'deribit:BTC-28JUN24-70000-C',
    tsMs: seq,
    recvMs: seq,
    sequence: seq,
    bids: [{ price: dec('0.0125'), size: dec(10) }],
    asks: [{ price: dec('0.013'), size: dec(5) }],
    quoteCurrency: 'BTC',
  };
}

describe('InMemoryEventBus', () => {
  it('delivers events and supports unsubscribe', () => {
    const bus = new InMemoryEventBus();
    const received: BookUpdate[] = [];
    const unsub = bus.on('market.book', (b) => received.push(b));
    bus.emit('market.book', makeBook(1));
    bus.emit('market.book', makeBook(2));
    unsub();
    bus.emit('market.book', makeBook(3));
    expect(received.map((b) => b.sequence)).toEqual([1, 2]);
  });

  it('does not leak across event types', () => {
    const bus = new InMemoryEventBus();
    let trades = 0;
    bus.on('market.trade', () => trades++);
    bus.emit('market.book', makeBook(1));
    expect(trades).toBe(0);
  });

  it('emitAll emits correlated batches', () => {
    const bus = new InMemoryEventBus();
    let books = 0;
    let statuses = 0;
    bus.on('market.book', () => books++);
    bus.on('connector.status', () => statuses++);
    emitAll(bus, [
      { type: 'market.book', payload: makeBook(1) },
      { type: 'connector.status', payload: { venue: 'deribit', state: 'connected', tsMs: 1 } },
    ]);
    expect(books).toBe(1);
    expect(statuses).toBe(1);
  });
});
