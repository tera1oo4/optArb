import pino from 'pino';
import {
  emitAll,
  InMemoryEventBus,
  VirtualClock,
  type AppEventMap,
  type AppEventType,
  type Venue,
} from '@optarb/core';
import { readCapture } from '@optarb/persistence';
import * as deribit from '@optarb/venue-deribit';
import * as bybit from '@optarb/venue-bybit';
import * as okx from '@optarb/venue-okx';
import * as binance from '@optarb/venue-binance';

/**
 * Replay engine v0 (ADR-0004): feeds a JSONL capture through the SAME
 * normalization pipeline as the live connectors, on a virtual clock.
 * Each venue keeps its own market context; entries route by `venue`.
 */
interface VenueReplay {
  handle: (raw: unknown) => { type: AppEventType; payload: AppEventMap[AppEventType] }[];
  onGap: (err: unknown) => boolean;
}

function makeVenueReplays(nowMs: () => number): Partial<Record<Venue, VenueReplay>> {
  const dctx = deribit.createMarketContext({ nowMs });
  const bctx = bybit.createMarketContext({ nowMs });
  const octx = okx.createMarketContext({ nowMs });
  const bnctx = binance.createMarketContext({ nowMs });
  return {
    deribit: {
      handle: (raw) => deribit.handleRawMessage(raw, dctx),
      onGap: (err) => {
        if (!(err instanceof deribit.SequenceGapError)) return false;
        dctx.books.get(err.instrument)?.reset();
        dctx.books.delete(err.instrument);
        return true;
      },
    },
    bybit: {
      handle: (raw) => bybit.handleRawMessage(raw, bctx),
      onGap: (err) => {
        if (!(err instanceof bybit.SequenceGapError)) return false;
        bctx.books.delete(err.instrument);
        bctx.bookSeq.delete(err.instrument);
        return true;
      },
    },
    okx: {
      handle: (raw) => okx.handleRawMessage(raw, octx),
      onGap: () => false,
    },
    binance: {
      handle: (raw) => binance.handleRawMessage(raw, bnctx),
      onGap: (err) => {
        if (!(err instanceof binance.SequenceGapError)) return false;
        binance.resetBook(bnctx, err.instrument);
        return true;
      },
    },
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: pnpm backtest <capture-file.jsonl>');
    process.exit(1);
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const bus = new InMemoryEventBus();
  const clock = new VirtualClock();

  const counters: Record<string, { book: number; trade: number; ticker: number }> = {};
  for (const v of ['deribit', 'bybit', 'okx', 'binance'])
    counters[v] = { book: 0, trade: 0, ticker: 0 };
  bus.on('market.book', (e) => counters[e.venue]!.book++);
  bus.on('market.trade', (e) => counters[e.venue]!.trade++);
  bus.on('market.ticker', (e) => counters[e.venue]!.ticker++);

  const replays = makeVenueReplays(() => clock.nowMs());

  let raw = 0;
  let skipped = 0;
  let gaps = 0;
  const started = Date.now();

  for await (const entry of readCapture(file)) {
    raw++;
    const replay = replays[entry.venue];
    if (!replay || entry.direction !== 'in') {
      skipped++;
      continue;
    }
    clock.set(entry.tsMs);
    try {
      emitAll(bus, replay.handle(entry.payload));
    } catch (err) {
      if (replay.onGap(err)) {
        gaps++;
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
