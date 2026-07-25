import type { InstrumentView } from '@optarb/marketdata';
import type { CrossVenueSignal } from '@optarb/signals';
import type { ExecutionIntent } from '@optarb/execution';

/** Converts a cross-venue signal into a two-legged paper intent. */
export function crossVenueIntent(
  signal: CrossVenueSignal,
  view: InstrumentView,
): ExecutionIntent | null {
  const buy = view.quotes.get(signal.buyVenue);
  const sell = view.quotes.get(signal.sellVenue);
  if (!buy || !sell) return null;
  if (buy.askUsd === null || sell.bidUsd === null) return null;
  if (buy.askSizeCoin === null || sell.bidSizeCoin === null) return null;

  const sizeCoin = buy.askSizeCoin.lte(sell.bidSizeCoin) ? buy.askSizeCoin : sell.bidSizeCoin;
  const quoteRecvMs = Math.max(buy.recvMs, sell.recvMs);
  return {
    signalId: `cross-venue:${view.key}:${signal.buyVenue}->${signal.sellVenue}:${signal.tsMs}`,
    signalKind: 'cross-venue',
    legs: [
      {
        venue: signal.buyVenue,
        instrumentId: signal.buyInstrumentId,
        viewKey: view.key,
        underlying: view.underlying,
        side: 'buy',
        priceUsd: buy.askUsd,
        sizeCoin,
        indexPriceUsd: buy.indexPriceUsd,
        quoteRecvMs,
      },
      {
        venue: signal.sellVenue,
        instrumentId: signal.sellInstrumentId,
        viewKey: view.key,
        underlying: view.underlying,
        side: 'sell',
        priceUsd: sell.bidUsd,
        sizeCoin,
        indexPriceUsd: sell.indexPriceUsd,
        quoteRecvMs,
      },
    ],
    tsMs: signal.tsMs,
  };
}
