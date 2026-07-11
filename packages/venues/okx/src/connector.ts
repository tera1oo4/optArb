import { z } from 'zod';
import {
  BaseWsConnector,
  dec,
  emitAll,
  instrumentId,
  type ConnectorDeps,
  type Instrument,
  type VenueConnector,
} from '@optarb/core';
import { createMarketContext, handleRawMessage, type OkxMarketContext } from './dispatch.js';
import { parseOkxSymbol } from './symbols.js';

/** OKX blocks non-browser User-Agent on REST via Cloudflare — always send one. */
export const OKX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface OkxConnectorConfig {
  wsUrl: string;
  restUrl: string;
  /** Demo trading environment: adds x-simulated-trading: 1 to REST + WS handshake */
  demoTrading: boolean;
  uly: 'BTC-USD' | 'ETH-USD';
  maxInstruments: number;
}

const DEFAULTS: OkxConnectorConfig = {
  wsUrl: 'wss://wspap.okx.com:8443/ws/v5/public',
  restUrl: 'https://www.okx.com',
  demoTrading: true,
  uly: 'BTC-USD',
  maxInstruments: 40,
};

const InstrumentsResponseSchema = z.object({
  code: z.string(),
  data: z.array(
    z
      .object({
        instId: z.string(),
        instFamily: z.string(),
        state: z.string(),
        expTime: z.string(),
        stk: z.string(),
        optType: z.enum(['C', 'P']),
        ctVal: z.string(),
        ctMult: z.string(),
        settleCcy: z.string(),
      })
      .passthrough(),
  ),
});

/**
 * OKX V5 option connector (ADR-0003): REST instrument discovery (browser UA
 * required by Cloudflare), WS public channels (tickers/books5/trades), raw-text
 * `ping` heartbeat. books5 pushes full top-5 each time, so no gap handling.
 */
export class OkxConnector extends BaseWsConnector implements VenueConnector {
  readonly venue = 'okx' as const;

  private readonly config: OkxConnectorConfig;
  private readonly ctx: OkxMarketContext;
  private readonly subscribed = new Map<string, Instrument>();

  constructor(config: Partial<OkxConnectorConfig>, deps: ConnectorDeps) {
    const merged = { ...DEFAULTS, ...config };
    const headers: Record<string, string> = { 'User-Agent': OKX_USER_AGENT };
    if (merged.demoTrading) headers['x-simulated-trading'] = '1';
    super(
      {
        wsUrl: merged.wsUrl,
        headers,
        heartbeatIntervalMs: 25_000,
      },
      deps,
    );
    this.config = merged;
    this.ctx = createMarketContext({
      bookDepth: 5,
      nowMs: () => deps.clock.nowMs(),
    });
  }

  get instruments(): Instrument[] {
    return [...this.subscribed.values()];
  }

  async loadInstruments(): Promise<Instrument[]> {
    const url =
      `${this.config.restUrl}/api/v5/public/instruments` +
      `?instType=OPTION&uly=${this.config.uly}`;
    const headers: Record<string, string> = { 'User-Agent': OKX_USER_AGENT };
    if (this.config.demoTrading) headers['x-simulated-trading'] = '1';
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`okx instruments failed: HTTP ${res.status}`);
    const json: unknown = await res.json();
    const parsed = InstrumentsResponseSchema.parse(json);
    if (parsed.code !== '0') throw new Error(`okx instruments: code ${parsed.code}`);

    // Demo env mixes in USD_UM-margined families; keep only the requested family.
    const live = parsed.data.filter((i) => i.state === 'live' && i.instFamily === this.config.uly);
    live.sort((a, b) => Number(a.expTime) - Number(b.expTime));

    const selected = live.slice(0, this.config.maxInstruments).map((i) => {
      const p = parseOkxSymbol(i.instId);
      const instrument: Instrument = {
        id: instrumentId('okx', i.instId),
        venue: 'okx',
        venueSymbol: i.instId,
        kind: 'option',
        underlying: p.underlying,
        expiryMs: Number(i.expTime),
        strike: dec(i.stk),
        optionType: i.optType === 'C' ? 'call' : 'put',
        // Face value × multiplier = base-asset units per contract (0.01 BTC typical).
        contractMultiplier: dec(i.ctVal).mul(i.ctMult),
        quoteCurrency: 'USD',
        settleCurrency: 'BTC',
      };
      this.ctx.instruments.set(i.instId, instrument);
      return instrument;
    });
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

  /** OKX heartbeat: raw text frame `ping` (server replies `pong`). */
  protected heartbeatPayload(): unknown {
    return 'ping';
  }

  protected onWsText(_text: string): void {
    // 'pong' and similar non-JSON frames — nothing to do.
  }

  protected onWsMessage(payload: unknown): void {
    const msg = payload as { event?: string; code?: string; msg?: string };
    if (msg.event === 'error') {
      this.deps.logger.warn('okx: ws error response', { code: msg.code, msg: msg.msg });
      return;
    }
    try {
      const events = handleRawMessage(payload, this.ctx);
      emitAll(this.deps.bus, events);
    } catch (err) {
      this.deps.logger.warn('okx: failed to handle ws message', { err: String(err) });
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private sendSubscribeAll(): void {
    const args: { channel: string; instId: string }[] = [];
    for (const instId of this.subscribed.keys()) {
      args.push({ channel: 'tickers', instId });
      args.push({ channel: 'books5', instId });
      args.push({ channel: 'trades', instId });
    }
    this.send({ op: 'subscribe', args });
  }
}
