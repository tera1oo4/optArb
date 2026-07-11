import { z } from 'zod';
import {
  BaseWsConnector,
  dec,
  emitAll,
  instrumentId,
  type ConnectorDeps,
  type Instrument,
  type QuoteCurrency,
  type VenueConnector,
} from '@optarb/core';
import {
  createMarketContext,
  handleRawMessage,
  SequenceGapError,
  type BybitMarketContext,
} from './dispatch.js';
import { parseBybitSymbol } from './symbols.js';

export interface BybitConnectorConfig {
  wsUrl: string;
  restUrl: string;
  baseCoin: 'BTC' | 'ETH';
  maxInstruments: number;
  bookDepth: 1 | 25 | 50 | 100 | 200;
  /**
   * Base-asset units per option contract. Bybit does not expose this via the
   * API; empirically (2026-07-11) 1 USDT-margined BTC option ≈ 1 BTC of notional
   * (matched against Deribit mark prices). Keep as config to revise easily.
   */
  contractMultiplier: string;
}

const DEFAULTS: BybitConnectorConfig = {
  wsUrl: 'wss://stream-testnet.bybit.com/v5/public/option',
  restUrl: 'https://api-testnet.bybit.com',
  baseCoin: 'BTC',
  maxInstruments: 40,
  // Testnet only pushes snapshots for depth 25 (50/100/200 are accepted but silent).
  bookDepth: 25,
  contractMultiplier: '1',
};

const InstrumentsResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    list: z.array(
      z
        .object({
          symbol: z.string(),
          status: z.string(),
          optionsType: z.enum(['Call', 'Put']),
          deliveryTime: z.string(),
          quoteCoin: z.string(),
          settleCoin: z.string(),
        })
        .passthrough(),
    ),
    nextPageCursor: z.string().optional(),
  }),
});

const SUBSCRIBE_BATCH = 10; // Bybit: max 10 topics per subscribe message

/**
 * Bybit V5 option connector (ADR-0003): REST instrument discovery, WS public
 * topics (tickers/orderbook/publicTrade), app-level ping heartbeat, book
 * resync on sequence gaps. Same dispatch path for live and replay.
 */
export class BybitConnector extends BaseWsConnector implements VenueConnector {
  readonly venue = 'bybit' as const;

  private readonly config: BybitConnectorConfig;
  private readonly ctx: BybitMarketContext;
  private readonly subscribed = new Map<string, Instrument>();
  private reqId = 0;

  constructor(config: Partial<BybitConnectorConfig>, deps: ConnectorDeps) {
    const merged = { ...DEFAULTS, ...config };
    super(
      {
        wsUrl: merged.wsUrl,
        heartbeatIntervalMs: 20_000, // Bybit requires ping at least every 20s
      },
      deps,
    );
    this.config = merged;
    this.ctx = createMarketContext({
      bookDepth: merged.bookDepth,
      nowMs: () => deps.clock.nowMs(),
    });
  }

  get instruments(): Instrument[] {
    return [...this.subscribed.values()];
  }

  async loadInstruments(): Promise<Instrument[]> {
    const out: Instrument[] = [];
    let cursor: string | undefined;
    do {
      const url =
        `${this.config.restUrl}/v5/market/instruments-info` +
        `?category=option&baseCoin=${this.config.baseCoin}&limit=1000` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bybit instruments-info failed: HTTP ${res.status}`);
      const json: unknown = await res.json();
      const parsed = InstrumentsResponseSchema.parse(json);
      if (parsed.retCode !== 0) throw new Error('bybit instruments-info: non-zero retCode');

      for (const i of parsed.result.list) {
        if (i.status !== 'Trading') continue;
        const p = parseBybitSymbol(i.symbol);
        const quote = i.quoteCoin as QuoteCurrency;
        const instrument: Instrument = {
          id: instrumentId('bybit', i.symbol),
          venue: 'bybit',
          venueSymbol: i.symbol,
          kind: 'option',
          underlying: p.underlying,
          expiryMs: Number(i.deliveryTime),
          strike: p.strike,
          optionType: i.optionsType === 'Call' ? 'call' : 'put',
          contractMultiplier: dec(this.config.contractMultiplier),
          quoteCurrency: quote,
          settleCurrency: i.settleCoin as QuoteCurrency,
        };
        out.push(instrument);
        if (out.length >= this.config.maxInstruments) break;
      }
      cursor = out.length >= this.config.maxInstruments ? undefined : parsed.result.nextPageCursor;
    } while (cursor);

    out.sort((a, b) => (a.expiryMs ?? 0) - (b.expiryMs ?? 0));
    const selected = out.slice(0, this.config.maxInstruments);
    for (const i of selected) this.ctx.instruments.set(i.venueSymbol, i);
    return selected;
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    for (const inst of instruments) {
      this.subscribed.set(inst.venueSymbol, inst);
      this.ctx.instruments.set(inst.venueSymbol, inst);
    }
    if (this.state === 'connected') this.sendSubscribeAll();
  }

  /* --------------------------- BaseWsConnector --------------------------- */

  protected onWsOpen(): void {
    if (this.subscribed.size > 0) this.sendSubscribeAll();
  }

  protected heartbeatPayload(): unknown {
    return { op: 'ping' };
  }

  protected onWsMessage(payload: unknown): void {
    try {
      const events = handleRawMessage(payload, this.ctx);
      emitAll(this.deps.bus, events);
    } catch (err) {
      if (err instanceof SequenceGapError) {
        this.deps.logger.warn('bybit: book sequence gap, resyncing', {
          instrument: err.instrument,
          expected: err.expected,
          got: err.got,
        });
        this.resyncBook(err.instrument);
      } else {
        this.deps.logger.warn('bybit: failed to handle ws message', { err: String(err) });
      }
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private topics(): string[] {
    const topics: string[] = [];
    for (const s of this.subscribed.keys()) {
      topics.push(`tickers.${s}`);
      topics.push(`orderbook.${this.config.bookDepth}.${s}`);
    }
    if (this.subscribed.size > 0) topics.push(`publicTrade.${this.config.baseCoin}`);
    return topics;
  }

  private sendSubscribeAll(): void {
    const topics = this.topics();
    for (let i = 0; i < topics.length; i += SUBSCRIBE_BATCH) {
      this.send({
        req_id: String(++this.reqId),
        op: 'subscribe',
        args: topics.slice(i, i + SUBSCRIBE_BATCH),
      });
    }
  }

  private resyncBook(symbol: string): void {
    this.ctx.books.delete(symbol);
    this.ctx.bookSeq.delete(symbol);
    const topic = `orderbook.${this.config.bookDepth}.${symbol}`;
    this.send({ req_id: String(++this.reqId), op: 'unsubscribe', args: [topic] });
    this.send({ req_id: String(++this.reqId), op: 'subscribe', args: [topic] });
  }
}
