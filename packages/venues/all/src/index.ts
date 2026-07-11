import type { ConnectorDeps, VenueConnector } from '@optarb/core';
import { DeribitConnector, type DeribitConnectorConfig } from '@optarb/venue-deribit';
import { BybitConnector, type BybitConnectorConfig } from '@optarb/venue-bybit';
import { OkxConnector, type OkxConnectorConfig } from '@optarb/venue-okx';
import { BinanceConnector, type BinanceConnectorConfig } from '@optarb/venue-binance';
import { PolymarketConnector, type PolymarketConnectorConfig } from '@optarb/venue-polymarket';

export { DeribitConnector } from '@optarb/venue-deribit';
export { BybitConnector } from '@optarb/venue-bybit';
export { OkxConnector } from '@optarb/venue-okx';
export { BinanceConnector } from '@optarb/venue-binance';
export { PolymarketConnector } from '@optarb/venue-polymarket';

/** Venues with a connector implementation. */
export const CONNECTOR_VENUES = ['deribit', 'bybit', 'okx', 'binance', 'polymarket'] as const;
export type ConnectorVenue = (typeof CONNECTOR_VENUES)[number];

export interface VenueRuntimeConfigs {
  deribit?: Partial<DeribitConnectorConfig>;
  bybit?: Partial<BybitConnectorConfig>;
  okx?: Partial<OkxConnectorConfig>;
  binance?: Partial<BinanceConnectorConfig>;
  polymarket?: Partial<PolymarketConnectorConfig>;
}

/** Shared factory used by apps/collector and apps/trader — one wiring, one truth. */
export function createVenueConnector(
  venue: ConnectorVenue,
  configs: VenueRuntimeConfigs,
  deps: ConnectorDeps,
): VenueConnector {
  switch (venue) {
    case 'deribit':
      return new DeribitConnector(configs.deribit ?? {}, deps);
    case 'bybit':
      return new BybitConnector(configs.bybit ?? {}, deps);
    case 'okx':
      return new OkxConnector(configs.okx ?? {}, deps);
    case 'binance':
      return new BinanceConnector(configs.binance ?? {}, deps);
    case 'polymarket':
      return new PolymarketConnector(configs.polymarket ?? {}, deps);
  }
}
