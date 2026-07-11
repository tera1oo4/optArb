import type { CaptureSink } from './capture.js';
import type { Clock } from './clock.js';
import type { EventBus } from './events.js';
import type { Logger } from './logger.js';
import type { Instrument, Venue } from './model.js';

/** Every venue implements this (ADR-0003). Polymarket binary contracts included. */
export interface VenueConnector {
  readonly venue: Venue;
  /** Fetch instrument metadata from the venue API — specs are never hardcoded. */
  loadInstruments(): Promise<Instrument[]>;
  connect(): Promise<void>;
  subscribe(instruments: Instrument[]): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ConnectorDeps {
  bus: EventBus;
  clock: Clock;
  capture: CaptureSink;
  logger: Logger;
}
