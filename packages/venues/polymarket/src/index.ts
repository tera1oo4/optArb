/**
 * @optarb/venue-polymarket — READ-ONLY Polymarket connector (no auth, no orders).
 *
 * Canonical mapping decision (M3):
 * - Polymarket binary markets are NOT vanilla options; each market is a YES/NO
 *   token pair paying $1. We model the YES token of a "Will BTC be above $K
 *   on date D?" market as a **digital call** (`kind: 'binary'`,
 *   `optionType: 'call'`) and the NO token as the matching **digital put** —
 *   the two are linked by sharing the same canonical parts
 *   (underlying, expiryMs from Gamma `endDate`, strike parsed from the question).
 * - Prices are 0–1 USDC per share; the marketdata store keeps binary
 *   instruments in a separate `binary:` view namespace so their prices never
 *   mix with vanilla premiums in the cross-venue detector.
 * - Question parsing is deliberately shallow (one regex pass): only
 *   expiry-level "above $X" questions get a strike. Touch markets
 *   ("reach $X", "dip to $X") and range/up-down markets are registered with
 *   `metadata.parseable: 'false'` and no strike → no consolidated view →
 *   pricing and detectors skip them automatically.
 */
export { PolymarketConnector } from './connector.js';
export type { PolymarketConnectorConfig } from './connector.js';
export { parsePolymarketQuestion } from './symbols.js';
export type { ParsedPolymarketQuestion } from './symbols.js';
export { createMarketContext, handleRawMessage, trackInstrument } from './dispatch.js';
export type { PolymarketMarketContext, DispatchedEvent } from './dispatch.js';
export {
  GammaMarketSchema,
  GammaMarketsResponseSchema,
  PolyBookEventSchema,
  PolyPriceChangeEventSchema,
  PolyLastTradeEventSchema,
  PolyBestBidAskEventSchema,
} from './messages.js';
