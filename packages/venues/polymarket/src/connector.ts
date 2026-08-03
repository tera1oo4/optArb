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
  createMarketContext,
  handleRawMessage,
  trackInstrument,
  type PolymarketMarketContext,
} from './dispatch.js';
import { GammaMarketsResponseSchema, parseGammaStringArray } from './messages.js';
import { parsePolymarketQuestion } from './symbols.js';

export interface PolymarketConnectorConfig {
  gammaUrl: string;
  wsUrl: string;
  /** Underlyings to load (matched against the market question text) */
  underlyings: Underlying[];
  /** Max binary markets to subscribe (each market = 2 token instruments) */
  maxMarkets: number;
  bookDepth: number;
}

const DEFAULTS: PolymarketConnectorConfig = {
  gammaUrl: 'https://gamma-api.polymarket.com',
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  underlyings: ['BTC'],
  maxMarkets: 20,
  bookDepth: 10,
};

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

/**
 * Polymarket CLOB connector — READ-ONLY, no auth, no orders (ADR-0006).
 * Instrument discovery via the public Gamma API, market data via the public
 * CLOB market channel. Client-driven heartbeat: `{}` every 10s (server drops
 * the connection after ~30s without it — verified 2026-07, ADR-0003).
 */
export class PolymarketConnector extends BaseWsConnector implements VenueConnector {
  readonly venue = 'polymarket' as const;

  private readonly config: PolymarketConnectorConfig;
  private readonly ctx: PolymarketMarketContext;
  private readonly subscribed = new Map<string, Instrument>();

  constructor(config: Partial<PolymarketConnectorConfig>, deps: ConnectorDeps) {
    const merged = { ...DEFAULTS, ...config };
    super({ wsUrl: merged.wsUrl, heartbeatIntervalMs: 10_000 }, deps);
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
    const selected: Instrument[] = [];
    let marketsSeen = 0;
    for (let page = 0; page < MAX_PAGES && selected.length < this.config.maxMarkets * 2; page++) {
      const url =
        `${this.config.gammaUrl}/markets?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}` +
        `&closed=false&active=true&order=volume24hr&ascending=false`;
      const res = await fetch(url);
      await assertHttpOk(res, 'polymarket gamma markets');
      const json: unknown = await res.json();
      const markets = GammaMarketsResponseSchema.parse(json);
      if (markets.length === 0) break;

      for (const m of markets) {
        if (selected.length >= this.config.maxMarkets * 2) break;
        marketsSeen++;
        const instruments = this.instrumentsFromMarket(m);
        for (const inst of instruments) {
          trackInstrument(this.ctx, inst);
          selected.push(inst);
        }
      }
      if (markets.length < PAGE_LIMIT) break;
    }
    this.deps.logger.info('polymarket: markets scanned', {
      marketsSeen,
      selectedMarkets: selected.length / 2,
    });
    return selected;
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    for (const inst of instruments) {
      this.subscribed.set(inst.venueSymbol, inst);
      trackInstrument(this.ctx, inst);
    }
    if (this.state === 'connected') this.sendSubscribeAll();
  }

  /* --------------------------- BaseWsConnector --------------------------- */

  protected onWsOpen(): void {
    if (this.subscribed.size > 0) this.sendSubscribeAll();
  }

  /** Client-driven heartbeat: empty JSON object every 10s (server acks `{}`). */
  protected heartbeatPayload(): unknown {
    return {};
  }

  protected onWsMessage(payload: unknown): void {
    try {
      const events = handleRawMessage(payload, this.ctx);
      emitAll(this.deps.bus, events);
    } catch (err) {
      this.deps.logger.warn('polymarket: failed to handle ws message', { err: String(err) });
    }
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * One Gamma market → two binary instruments (YES = digital call, NO = digital
   * put). Markets whose question is not a supported-underlying "above $X"
   * comparison are registered with strike null / parseable 'false' — they get
   * no consolidated view, so pricing and detectors skip them automatically.
   * Markets without a recognizable BTC/ETH underlying or without Yes/No
   * outcomes are skipped entirely.
   */
  private instrumentsFromMarket(m: {
    question: string;
    conditionId: string;
    endDate?: string;
    outcomes: string;
    clobTokenIds: string;
    negRisk?: boolean;
    minimumTickSize?: string;
  }): Instrument[] {
    const parsed = parsePolymarketQuestion(m.question);
    if (parsed.underlying === null || !this.config.underlyings.includes(parsed.underlying)) {
      return [];
    }
    const tokenIds = parseGammaStringArray(m.clobTokenIds);
    const outcomes = parseGammaStringArray(m.outcomes);
    if (!tokenIds || !outcomes || tokenIds.length !== outcomes.length) return [];

    if (!m.endDate) return [];
    const expiryMs = Date.parse(m.endDate);
    if (Number.isNaN(expiryMs)) return [];

    const instruments: Instrument[] = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const outcome = outcomes[i];
      const tokenId = tokenIds[i];
      if (outcome === undefined || tokenId === undefined) continue;
      const normalized = outcome.toLowerCase();
      if (normalized !== 'yes' && normalized !== 'no') continue;
      instruments.push({
        id: instrumentId('polymarket', tokenId),
        venue: 'polymarket',
        venueSymbol: tokenId,
        kind: 'binary',
        underlying: parsed.underlying,
        expiryMs,
        strike: parsed.strike,
        // YES token pays $1 iff the event happens → digital call; NO → digital put.
        optionType: normalized === 'yes' ? 'call' : 'put',
        contractMultiplier: dec(1), // 1 share pays exactly $1
        quoteCurrency: 'USDC', // CLOB prices are 0–1 USDC per share
        settleCurrency: 'USDC',
        metadata: {
          conditionId: m.conditionId,
          question: m.question,
          outcome,
          parseable: String(parsed.parseable),
          negRisk: String(m.negRisk ?? false),
          tickSize: m.minimumTickSize ?? '0.001',
        },
      });
    }
    return instruments;
  }

  private sendSubscribeAll(): void {
    this.send({
      assets_ids: [...this.subscribed.keys()],
      type: 'market',
      // Enables best_bid_ask (plus new_market / market_resolved lifecycle events).
      custom_feature_enabled: true,
    });
  }
}
