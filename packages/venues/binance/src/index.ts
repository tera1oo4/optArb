export { BinanceConnector } from './connector.js';
export type { BinanceConnectorConfig } from './connector.js';
export { parseBinanceSymbol, toStreamSymbol } from './symbols.js';
export type { ParsedBinanceSymbol } from './symbols.js';
export {
  createMarketContext,
  handleRawMessage,
  ensureInstrument,
  applyRestSnapshot,
  resetBook,
  SequenceGapError,
} from './dispatch.js';
export type { BinanceMarketContext, DispatchedEvent, RestDepth } from './dispatch.js';
export {
  BinanceWsMessageSchema,
  MarkPriceEntrySchema,
  MarkPriceDataSchema,
  DepthUpdateSchema,
  OptionTradeSchema,
  RestDepthSchema,
} from './messages.js';
