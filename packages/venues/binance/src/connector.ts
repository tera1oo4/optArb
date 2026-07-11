import { z } from 'zod';
import {
  assertHttpOk,
  BaseWsConnector,
  dec,
  emitAll,
  instrumentId,
  type ConnectorDeps,
  type Instrument,
  type Underlying,
  type VenueConnector,
} from '@optarb/core';
import {
  applyRestSnapshot,
  createMarketContext,
  handleRawMessage,
  resetBook,
  SequenceGapError,
  type BinanceMarketContext,
} from './dispatch.js';
import { RestDepthSchema } from './messages.js';
import { parseBinanceSymbol, toStreamSymbol } from './symbols.js';

export interface BinanceConnectorConfig {
  marketWsUrl: string;
  publicWsUrl: string;
  restUrl: string;
  underlyings: Underlying[];
  maxInstruments: number;
  bookDepth: 10 | 20 | 50 | 100;
}

const DEFAULTS: BinanceConnectorConfig = {
  // Binance moved option streams from nbstream/eoptions (now 404) to fstream (2026).
  marketWsUrl: 'wss://fstream.binance.com/market/stream',
  publicWsUrl: 'wss://fstream.binance.com/public/stream',
  restUrl: 'https://eapi.binance.com',
  underlyings: ['BTC'],
  maxInstruments: 40,
  bookDepth: 10,
};

const ExchangeInfoSchema = z.object({
  optionSymbols: z.array(
    z
      .object({
        symbol: z.string(),
        side: z.enum(['CALL', 'PUT']),
        strikePrice: z.string(),
        underlying: z.string(),
        unit: z.number(),
        expiryDate: z.number(),
        quoteAsset: z.string(),
        status: z.string(),
      })
      .passthrough(),
  ),
});

const SUBSCRIBE_BATCH = 100; // server limit: 200 streams per connection

/** One fstream connection; tracks its stream set and resubscribes on reconnect. */
class BinanceStreamSocket extends BaseWsConnector {
  readonly venue = 'binance' as const;

  private readonly streams = new Set<string>();
  private reqId = 0;

  constructor(
    url: string,
    private readonly label: string,
    private readonly route: (payload: unknown) => void,
    deps: ConnectorDeps,
  ) {
    super({ wsUrl: url }, deps);
  }

  subscribeStreams(streams: string[]): void {
    const fresh: string[] = [];
    for (const s of streams) {
      if (!this.streams.has(s)) {
        this.streams.add(s);
        fresh.push(s);
      }
    }
    if (fresh.length > 0 && this.state === 'connected') this.sendSubscribe(fresh);
  }

  protected onWsOpen(): void {
    this.emitStatus('connected', this.label);
    if (this.streams.size > 0) this.sendSubscribe([...this.streams]);
  }

  protected onWsMessage(payload: unknown): void {
    this.route(payload);
  }

  private sendSubscribe(streams: string[]): void {
    for (let i = 0; i < streams.length; i += SUBSCRIBE_BATCH) {
      this.send({
        method: 'SUBSCRIBE',
        params: streams.slice(i, i + SUBSCRIBE_BATCH),
        id: ++this.reqId,
      });
    }
  }
}

/**
 * Binance European options connector (ADR-0003). Two fstream connections:
 * - market socket: `{underlying}usdt@optionMarkPrice` — BBO + mark + IV + greeks
 *   for the whole market every second;
 * - public socket: `{symbol}@depth10@100ms` (futures-style diff depth, REST
 *   snapshot sync) and `{symbol}@optionTrade`.
 * Read-only public streams — no testnet exists for Binance options.
 */
export class BinanceConnector implements VenueConnector {
  readonly venue = 'binance' as const;

  private readonly config: BinanceConnectorConfig;
  private readonly ctx: BinanceMarketContext;
  private readonly subscribed = new Map<string, Instrument>();
  private readonly marketSocket: BinanceStreamSocket;
  private readonly publicSocket: BinanceStreamSocket;

  private readonly snapshotInFlight = new Set<string>();
  private readonly snapshotLastAttempt = new Map<string, number>();

  constructor(
    config: Partial<BinanceConnectorConfig>,
    private readonly deps: ConnectorDeps,
  ) {
    this.config = { ...DEFAULTS, ...config };
    this.ctx = createMarketContext({
      bookDepth: this.config.bookDepth,
      nowMs: () => deps.clock.nowMs(),
      onRebaseNeeded: (symbol) => void this.fetchSnapshot(symbol),
    });
    const route = (payload: unknown) => this.route(payload);
    this.marketSocket = new BinanceStreamSocket(this.config.marketWsUrl, 'market', route, deps);
    this.publicSocket = new BinanceStreamSocket(this.config.publicWsUrl, 'public', route, deps);
  }

  get instruments(): Instrument[] {
    return [...this.subscribed.values()];
  }

  async loadInstruments(): Promise<Instrument[]> {
    const res = await fetch(`${this.config.restUrl}/eapi/v1/exchangeInfo`);
    await assertHttpOk(res, 'binance exchangeInfo');
    const json: unknown = await res.json();
    const parsed = ExchangeInfoSchema.parse(json);

    const wanted = new Set(this.config.underlyings.map((u) => `${u}USDT`));
    const active = parsed.optionSymbols.filter(
      (s) => s.status === 'TRADING' && wanted.has(s.underlying),
    );
    active.sort((a, b) => a.expiryDate - b.expiryDate);

    const selected = active.slice(0, this.config.maxInstruments).map((s) => {
      const p = parseBinanceSymbol(s.symbol);
      const instrument: Instrument = {
        id: instrumentId('binance', s.symbol),
        venue: 'binance',
        venueSymbol: s.symbol,
        kind: 'option',
        underlying: p.underlying,
        expiryMs: s.expiryDate,
        strike: dec(s.strikePrice),
        optionType: s.side === 'CALL' ? 'call' : 'put',
        contractMultiplier: dec(s.unit),
        quoteCurrency: 'USDT',
        settleCurrency: 'USDT',
      };
      this.ctx.instruments.set(s.symbol, instrument);
      return instrument;
    });
    return selected;
  }

  async connect(): Promise<void> {
    await Promise.all([this.marketSocket.connect(), this.publicSocket.connect()]);
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    for (const inst of instruments) {
      this.subscribed.set(inst.venueSymbol, inst);
      this.ctx.instruments.set(inst.venueSymbol, inst);
    }
    const marketStreams = this.config.underlyings.map(
      (u) => `${u.toLowerCase()}usdt@optionMarkPrice`,
    );
    this.marketSocket.subscribeStreams(marketStreams);

    const publicStreams: string[] = [];
    for (const s of this.subscribed.keys()) {
      const low = toStreamSymbol(s);
      publicStreams.push(`${low}@depth${this.config.bookDepth}@100ms`, `${low}@optionTrade`);
    }
    this.publicSocket.subscribeStreams(publicStreams);
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.marketSocket.disconnect(), this.publicSocket.disconnect()]);
  }

  /* ------------------------------ internals ------------------------------ */

  private route(payload: unknown): void {
    try {
      const events = handleRawMessage(payload, this.ctx);
      emitAll(this.deps.bus, events);
    } catch (err) {
      if (err instanceof SequenceGapError) {
        this.deps.logger.warn('binance: book gap, resyncing', {
          instrument: err.instrument,
          detail: err.detail,
        });
        resetBook(this.ctx, err.instrument);
        void this.fetchSnapshot(err.instrument);
      } else {
        this.deps.logger.warn('binance: failed to handle ws message', { err: String(err) });
      }
    }
  }

  private async fetchSnapshot(symbol: string): Promise<void> {
    const now = this.deps.clock.nowMs();
    const lastAttempt = this.snapshotLastAttempt.get(symbol) ?? 0;
    if (this.snapshotInFlight.has(symbol) || now - lastAttempt < 2_000) return;
    this.snapshotInFlight.add(symbol);
    this.snapshotLastAttempt.set(symbol, now);
    try {
      const url =
        `${this.config.restUrl}/eapi/v1/depth` +
        `?symbol=${encodeURIComponent(symbol)}&limit=${this.config.bookDepth}`;
      const res = await fetch(url);
      await assertHttpOk(res, 'binance depth');
      const json: unknown = await res.json();
      const snapshot = RestDepthSchema.parse(json);
      const events = applyRestSnapshot(this.ctx, symbol, snapshot);
      emitAll(this.deps.bus, events);
    } catch (err) {
      // Next incoming diff re-triggers the cycle (after the 2s cooldown).
      resetBook(this.ctx, symbol);
      this.deps.logger.warn('binance: depth snapshot failed', { symbol, err: String(err) });
    } finally {
      this.snapshotInFlight.delete(symbol);
    }
  }
}
