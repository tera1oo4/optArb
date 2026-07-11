import { EventEmitter } from 'node:events';
import type { BookUpdate, ConnectorStatus, TickerUpdate, TradeUpdate } from './model.js';

/** Typed event map of the whole system (ADR-0004). */
export interface AppEventMap {
  'market.book': BookUpdate;
  'market.trade': TradeUpdate;
  'market.ticker': TickerUpdate;
  'connector.status': ConnectorStatus;
}

export type AppEventType = keyof AppEventMap;

export interface EventBus {
  emit<K extends AppEventType>(type: K, payload: AppEventMap[K]): void;
  on<K extends AppEventType>(type: K, handler: (payload: AppEventMap[K]) => void): () => void;
  off<K extends AppEventType>(type: K, handler: (payload: AppEventMap[K]) => void): void;
}

/** v1 in-process bus (ADR-0004); swappable for NATS later without touching packages. */
export class InMemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit<K extends AppEventType>(type: K, payload: AppEventMap[K]): void {
    this.emitter.emit(type, payload);
  }

  on<K extends AppEventType>(type: K, handler: (payload: AppEventMap[K]) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.off(type, handler);
  }

  off<K extends AppEventType>(type: K, handler: (payload: AppEventMap[K]) => void): void {
    this.emitter.off(type, handler);
  }
}

/** Emits a batch of events whose type/payload are correlated by construction (venue dispatch). */
export function emitAll(
  bus: EventBus,
  events: Iterable<{ type: AppEventType; payload: AppEventMap[AppEventType] }>,
): void {
  const emit = bus.emit.bind(bus) as (t: AppEventType, p: AppEventMap[AppEventType]) => void;
  for (const ev of events) emit(ev.type, ev.payload);
}
