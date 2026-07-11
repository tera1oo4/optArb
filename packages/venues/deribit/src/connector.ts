import WebSocket from 'ws';
import { z } from 'zod';
import {
  dec,
  emitAll,
  instrumentId,
  type ConnectorDeps,
  type ConnectorState,
  type Instrument,
  type VenueConnector,
} from '@optarb/core';
import { SequenceGapError } from './book-builder.js';
import {
  createMarketContext,
  handleChannelMessage,
  type DeribitMarketContext,
} from './dispatch.js';

export interface DeribitConnectorConfig {
  wsUrl: string;
  restUrl: string;
  currency: 'BTC' | 'ETH';
  maxInstruments: number;
  bookDepth: number;
  tickerInterval: '100ms' | 'raw';
}

const DEFAULTS: DeribitConnectorConfig = {
  wsUrl: 'wss://test.deribit.com/ws/api/v2',
  restUrl: 'https://test.deribit.com/api/v2',
  currency: 'BTC',
  maxInstruments: 40,
  bookDepth: 10,
  tickerInterval: '100ms',
};

const InstrumentsResponseSchema = z.object({
  result: z.array(
    z
      .object({
        instrument_name: z.string(),
        kind: z.string(),
        expiration_timestamp: z.number(),
        strike: z.number().optional(),
        option_type: z.enum(['call', 'put']).optional(),
        contract_size: z.number().optional(),
        is_active: z.boolean(),
      })
      .passthrough(),
  ),
});

interface RpcEnvelope {
  method?: string;
  params?: { channel?: string; data?: unknown; type?: string };
  id?: number;
  error?: unknown;
}

/**
 * Native Deribit connector (ADR-0003): JSON-RPC 2.0 over WS, instrument metadata
 * from the API, heartbeat via set_heartbeat, reconnect with backoff, book
 * resync on sequence gaps, raw capture of every frame for replay.
 */
export class DeribitConnector implements VenueConnector {
  readonly venue = 'deribit' as const;

  private readonly config: DeribitConnectorConfig;
  private readonly ctx: DeribitMarketContext;
  private readonly subscribed = new Map<string, Instrument>();

  private ws: WebSocket | null = null;
  private requestId = 0;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: ConnectorState = 'disconnected';

  constructor(
    config: Partial<DeribitConnectorConfig>,
    private readonly deps: ConnectorDeps,
  ) {
    this.config = { ...DEFAULTS, ...config };
    this.ctx = createMarketContext({
      bookDepth: this.config.bookDepth,
      nowMs: () => deps.clock.nowMs(),
    });
  }

  get instruments(): Instrument[] {
    return [...this.subscribed.values()];
  }

  async loadInstruments(): Promise<Instrument[]> {
    const url =
      `${this.config.restUrl}/public/get_instruments` +
      `?currency=${this.config.currency}&kind=option&expired=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`get_instruments failed: HTTP ${res.status}`);
    const json: unknown = await res.json();
    const parsed = InstrumentsResponseSchema.parse(json);

    const active = parsed.result.filter((i) => i.is_active);
    active.sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

    return active.slice(0, this.config.maxInstruments).map((i) => {
      const instrument: Instrument = {
        id: instrumentId('deribit', i.instrument_name),
        venue: 'deribit',
        venueSymbol: i.instrument_name,
        kind: 'option',
        underlying: this.config.currency,
        expiryMs: i.expiration_timestamp,
        strike: i.strike != null ? dec(i.strike) : null,
        optionType: i.option_type ?? null,
        contractMultiplier: dec(i.contract_size ?? 1),
        quoteCurrency: this.config.currency,
        settleCurrency: this.config.currency,
      };
      this.ctx.instruments.set(i.instrument_name, instrument);
      return instrument;
    });
  }

  async connect(): Promise<void> {
    if (this.ws || this.state === 'connecting') return;
    this.intentionalClose = false;
    await this.openSocket();
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    for (const inst of instruments) {
      this.subscribed.set(inst.venueSymbol, inst);
      this.ctx.instruments.set(inst.venueSymbol, inst);
    }
    if (this.state === 'connected') this.sendSubscribe([...this.subscribed.keys()]);
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    this.state = 'disconnected';
    ws?.close();
    this.emitStatus('disconnected', 'closed by client');
  }

  /* ------------------------------- internals ------------------------------- */

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      this.emitStatus('connecting');
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;

      const onEarlyError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        ws.off('error', onEarlyError);
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this.emitStatus('connected');
        this.send('public/set_heartbeat', { interval: 30 });
        if (this.subscribed.size > 0) this.sendSubscribe([...this.subscribed.keys()]);
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onEarlyError);
      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));
      ws.on('close', () => this.onClose());
      ws.on('error', (err) => this.deps.logger.error('deribit ws error', { err: String(err) }));
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.deps.logger.warn('deribit: unparseable ws frame');
      return;
    }

    this.deps.capture.record({
      tsMs: this.deps.clock.nowMs(),
      venue: this.venue,
      channel: 'ws',
      direction: 'in',
      payload: msg,
    });

    const envelope = msg as RpcEnvelope;
    if (envelope.method === 'heartbeat' && envelope.params?.type === 'test_request') {
      this.send('public/test', {});
      return;
    }
    if (envelope.method === 'subscription' && envelope.params?.channel) {
      try {
        const events = handleChannelMessage(
          envelope.params.channel,
          envelope.params.data,
          this.ctx,
        );
        emitAll(this.deps.bus, events);
      } catch (err) {
        if (err instanceof SequenceGapError) {
          this.deps.logger.warn('deribit: book sequence gap, resyncing', {
            instrument: err.instrument,
            expected: err.expected,
            got: err.got,
          });
          this.resyncBook(err.instrument);
        } else {
          this.deps.logger.warn('deribit: failed to handle channel message', {
            channel: envelope.params.channel,
            err: String(err),
          });
        }
      }
      return;
    }
    if (envelope.error) {
      this.deps.logger.warn('deribit: rpc error response', {
        id: envelope.id,
        error: envelope.error,
      });
    }
  }

  private onClose(): void {
    this.ws = null;
    const wasIntentional = this.intentionalClose;
    this.state = 'disconnected';
    this.emitStatus('disconnected', wasIntentional ? 'closed by client' : 'connection lost');
    if (!wasIntentional) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(500 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 500);
    this.emitStatus('reconnecting', `attempt ${attempt + 1} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket().catch((err) => {
        this.deps.logger.warn('deribit: reconnect attempt failed', { err: String(err) });
        // Failure also surfaces via ws 'close' → onClose schedules the next attempt.
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resyncBook(symbol: string): void {
    this.ctx.books.get(symbol)?.reset();
    this.ctx.books.delete(symbol);
    const channel = `book.${symbol}.none.${this.config.bookDepth}.100ms`;
    this.send('public/unsubscribe', { channels: [channel] });
    this.send('public/subscribe', { channels: [channel] });
  }

  private sendSubscribe(symbols: string[]): void {
    const channels: string[] = [];
    for (const s of symbols) {
      channels.push(`ticker.${s}.${this.config.tickerInterval}`);
      channels.push(`book.${s}.none.${this.config.bookDepth}.100ms`);
      channels.push(`trades.${s}.100ms`);
    }
    for (let i = 0; i < channels.length; i += 50) {
      this.send('public/subscribe', { channels: channels.slice(i, i + 50) });
    }
  }

  private send(method: string, params: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = { jsonrpc: '2.0', id: ++this.requestId, method, params };
    this.ws.send(JSON.stringify(payload));
    this.deps.capture.record({
      tsMs: this.deps.clock.nowMs(),
      venue: this.venue,
      channel: 'ws',
      direction: 'out',
      payload,
    });
  }

  private emitStatus(state: ConnectorState, detail?: string): void {
    this.deps.bus.emit('connector.status', {
      venue: this.venue,
      state,
      tsMs: this.deps.clock.nowMs(),
      detail,
    });
  }
}
