import { type AppEventMap, type AppEventType, type Instrument, type Venue } from '@optarb/core';
import * as binance from '@optarb/venue-binance';
import * as bybit from '@optarb/venue-bybit';
import * as deribit from '@optarb/venue-deribit';
import * as okx from '@optarb/venue-okx';
import * as polymarket from '@optarb/venue-polymarket';

/** Per-venue replay state: normalization pipeline + context for instrument discovery. */
export interface VenueReplay {
  handle: (raw: unknown) => { type: AppEventType; payload: AppEventMap[AppEventType] }[];
  onGap: (err: unknown) => boolean;
  context: { instruments: Map<string, Instrument> };
}

/** Builds the same normalization contexts used by the live connectors (ADR-0004). */
export function makeVenueReplays(nowMs: () => number): Partial<Record<Venue, VenueReplay>> {
  const dctx = deribit.createMarketContext({ nowMs });
  const bctx = bybit.createMarketContext({ nowMs });
  const octx = okx.createMarketContext({ nowMs });
  const bnctx = binance.createMarketContext({ nowMs });
  const pctx = polymarket.createMarketContext({ nowMs });

  return {
    deribit: {
      handle: (raw) => deribit.handleRawMessage(raw, dctx),
      onGap: (err) => {
        if (!(err instanceof deribit.SequenceGapError)) return false;
        dctx.books.get(err.instrument)?.reset();
        dctx.books.delete(err.instrument);
        return true;
      },
      context: dctx,
    },
    bybit: {
      handle: (raw) => bybit.handleRawMessage(raw, bctx),
      onGap: (err) => {
        if (!(err instanceof bybit.SequenceGapError)) return false;
        bctx.books.delete(err.instrument);
        bctx.bookSeq.delete(err.instrument);
        return true;
      },
      context: bctx,
    },
    okx: {
      handle: (raw) => okx.handleRawMessage(raw, octx),
      onGap: () => false,
      context: octx,
    },
    binance: {
      handle: (raw) => binance.handleRawMessage(raw, bnctx),
      onGap: (err) => {
        if (!(err instanceof binance.SequenceGapError)) return false;
        binance.resetBook(bnctx, err.instrument);
        return true;
      },
      context: bnctx,
    },
    polymarket: {
      handle: (raw) => polymarket.handleRawMessage(raw, pctx),
      onGap: () => false,
      context: pctx,
    },
  };
}
