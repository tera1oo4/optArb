import { z } from 'zod';
import {
  assertHttpOk,
  BaseWsConnector,
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
        tick_size: z.number().optional(),
        min_trade_amount: z.number().optional(),
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
 *
 * Refactored to extend the shared BaseWsConnector so lifecycle/reconnect code
 * is not duplicated per venue.
 */
export class DeribitConnector extends BaseWsConnector implements VenueConnector {
  readonly venue = 'deribit' as const;

  private readonly config: DeribitConnectorConfig;
  private readonly ctx: DeribitMarketContext;
  private readonly subscribed = new Map<string, Instrument>();
  private requestId = 0;

  constructor(config: Partial<DeribitConnectorConfig>, deps: ConnectorDeps) {
    super({ wsUrl: { ...DEFAULTS, ...config }.wsUrl }, deps);
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
    await assertHttpOk(res, 'deribit get_instruments');
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
        metadata: {
          ...(i.tick_size != null ? { tickSize: String(i.tick_size) } : {}),
          ...(i.min_trade_amount != null ? { minTradeAmount: String(i.min_trade_amount) } : {}),
        },
      };
      this.ctx.instruments.set(i.instrument_name, instrument);
      return instrument;
    });
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    for (const inst of instruments) {
      this.subscribed.set(inst.venueSymbol, inst);
      this.ctx.instruments.set(inst.venueSymbol, inst);
    }
    if (this.state === 'connected') this.sendSubscribe([...this.subscribed.keys()]);
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
  }

  /** Called after the socket opens: enable Deribit heartbeats and resubscribe. */
  protected onWsOpen(): void {
    this.sendRpc('public/set_heartbeat', { interval: 30 });
    if (this.subscribed.size > 0) this.sendSubscribe([...this.subscribed.keys()]);
  }

  /** Called for each parsed JSON message. */
  protected onWsMessage(payload: unknown): void {
    const envelope = payload as RpcEnvelope;
    if (envelope.method === 'heartbeat' && envelope.params?.type === 'test_request') {
      this.sendRpc('public/test', {});
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

  /** Override status emission to use the concrete venue name. */
  protected emitStatus(state: ConnectorState, detail?: string): void {
    this.deps.bus.emit('connector.status', {
      venue: this.venue,
      state,
      tsMs: this.deps.clock.nowMs(),
      detail,
    });
  }

  private resyncBook(symbol: string): void {
    this.ctx.books.get(symbol)?.reset();
    this.ctx.books.delete(symbol);
    const channel = `book.${symbol}.none.${this.config.bookDepth}.100ms`;
    this.sendRpc('public/unsubscribe', { channels: [channel] });
    this.sendRpc('public/subscribe', { channels: [channel] });
  }

  private sendSubscribe(symbols: string[]): void {
    const channels: string[] = [];
    for (const s of symbols) {
      channels.push(`ticker.${s}.${this.config.tickerInterval}`);
      channels.push(`book.${s}.none.${this.config.bookDepth}.100ms`);
      channels.push(`trades.${s}.100ms`);
    }
    for (let i = 0; i < channels.length; i += 50) {
      this.sendRpc('public/subscribe', { channels: channels.slice(i, i + 50) });
    }
  }

  private sendRpc(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', id: ++this.requestId, method, params });
  }
}
