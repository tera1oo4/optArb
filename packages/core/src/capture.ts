import type { Venue } from './model.js';

/** One raw message as received/sent on the wire — canonical replay source (ADR-0004). */
export interface RawCapture {
  /** Local timestamp, epoch ms */
  tsMs: number;
  venue: Venue;
  /** Logical channel: 'ws', 'rest', or a subscription channel */
  channel: string;
  direction: 'in' | 'out';
  /** Raw JSON-serializable payload */
  payload: unknown;
}

export interface CaptureSink {
  record(entry: RawCapture): void;
  close(): Promise<void>;
}

export const nullCapture: CaptureSink = {
  record: () => {},
  close: async () => {},
};
