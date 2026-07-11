import pino from 'pino';
import { emitAll, InMemoryEventBus, VirtualClock } from '@optarb/core';
import { readCapture } from '@optarb/persistence';
import { createMarketContext, handleRawMessage, SequenceGapError } from '@optarb/venue-deribit';

/**
 * Replay engine v0 (ADR-0004): feeds a JSONL capture through the SAME
 * normalization pipeline as the live connector, on a virtual clock.
 */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: pnpm backtest <capture-file.jsonl>');
    process.exit(1);
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const bus = new InMemoryEventBus();
  const clock = new VirtualClock();

  const counters = { book: 0, trade: 0, ticker: 0 };
  bus.on('market.book', () => counters.book++);
  bus.on('market.trade', () => counters.trade++);
  bus.on('market.ticker', () => counters.ticker++);

  const ctx = createMarketContext({ nowMs: () => clock.nowMs() });

  let raw = 0;
  let skipped = 0;
  let gaps = 0;
  const started = Date.now();

  for await (const entry of readCapture(file)) {
    raw++;
    if (entry.venue !== 'deribit' || entry.direction !== 'in') {
      skipped++;
      continue;
    }
    clock.set(entry.tsMs);
    try {
      emitAll(bus, handleRawMessage(entry.payload, ctx));
    } catch (err) {
      if (err instanceof SequenceGapError) {
        gaps++;
        ctx.books.get(err.instrument)?.reset();
        ctx.books.delete(err.instrument);
      } else {
        skipped++;
        log.warn({ err: String(err) }, 'replay: skipped malformed entry');
      }
    }
  }

  log.info(
    {
      file,
      raw,
      skipped,
      sequenceGaps: gaps,
      events: counters,
      wallMs: Date.now() - started,
      virtualEndMs: clock.nowMs(),
    },
    'replay finished',
  );
}

main().catch((err: unknown) => {
  console.error('backtest fatal error', err);
  process.exit(1);
});
