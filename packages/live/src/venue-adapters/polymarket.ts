import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ClobClient,
  OrderType,
  Side,
  Chain,
  type ApiKeyCreds,
  type TickSize,
} from '@polymarket/clob-client-v2';

import { dec, type Logger, type Venue } from '@optarb/core';
import type { GatewayOrderEvent, OrderGateway, OrderRequest, TimeInForce } from '../order-gateway.js';

export interface PolymarketGatewayConfig {
  /** Hex private key with or without 0x prefix. Controls real USDC funds. */
  privateKey: string;
  /** CLOB host; defaults to production. */
  host?: string;
  /** Chain id; defaults to Polygon mainnet (137). */
  chainId?: number;
  logger?: Logger;
}

const DEFAULT_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

/**
 * Polymarket CLOB order gateway.
 *
 * Uses the official `@polymarket/clob-client-v2` SDK:
 *   - viem WalletClient signs the EIP-712 message to derive L1 API credentials.
 *   - createAndPostOrder submits a resting GTC limit order to the off-chain book.
 *   - getOrder is polled until the order reaches a terminal state.
 *
 * IMPORTANT: Polymarket has no CLOB testnet. This adapter hits production and
 * can spend real USDC on Polygon. It is only instantiated when the operator
 * explicitly enables live trading and supplies POLYMARKET_PRIVATE_KEY.
 */
export class PolymarketOrderGateway implements OrderGateway {
  readonly venue: Venue = 'polymarket';

  private readonly config: PolymarketGatewayConfig;
  private client: ClobClient | null = null;
  private clientPromise: Promise<ClobClient> | null = null;
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportedFilled = new Map<string, number>();

  constructor(config: PolymarketGatewayConfig) {
    this.config = config;
  }

  async submit(req: OrderRequest, onEvent: (event: GatewayOrderEvent) => void): Promise<void> {
    try {
      const client = await this.ensureAuthenticated();

      const tokenId = tokenIdFromInstrumentId(req.instrumentId);
      const tickSize = req.metadata?.tickSize ?? '0.001';
      const negRisk = req.metadata?.negRisk === 'true';

      const side = req.side === 'buy' ? Side.BUY : Side.SELL;
      const price = Number(req.priceUsd.toString());
      const size = Number(req.sizeCoin.toString());
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        throw new Error(`invalid Polymarket price ${price}; must be in (0,1)`);
      }
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`invalid Polymarket size ${size}`);
      }

      const response = await client.createAndPostOrder(
        { tokenID: tokenId, side, price, size },
        { tickSize: tickSize as TickSize, negRisk },
        polymarketOrderType(req.timeInForce),
      );

      if (response.errorMsg || !response.orderID) {
        throw new Error(response.errorMsg || 'createAndPostOrder returned no orderID');
      }

      const orderId = response.orderID;
      onEvent({ kind: 'ack', tsMs: Date.now(), exchangeOrderId: orderId });
      this.startPolling(orderId, req, onEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.config.logger?.error('polymarket submit failed', {
        instrumentId: req.instrumentId,
        err: message,
      });
      onEvent({ kind: 'reject', tsMs: Date.now(), reason: message });
    }
  }

  async cancel(exchangeOrderId: string): Promise<void> {
    this.stopPolling(exchangeOrderId);
    const client = await this.ensureAuthenticated();
    await client.cancelOrder({ orderID: exchangeOrderId });
  }

  private startPolling(
    orderId: string,
    req: OrderRequest,
    onEvent: (event: GatewayOrderEvent) => void,
  ): void {
    this.stopPolling(orderId);

    const tick = async () => {
      try {
        const client = await this.ensureAuthenticated();
        const order = (await client.getOrder(orderId)) as {
          status?: 'LIVE' | 'FILLED' | 'PARTIAL_FILLED' | 'CANCELLED' | string;
          sizeMatched?: string;
          price?: string;
          size?: string;
        };
        this.handleOrderUpdate(orderId, order, req, onEvent);

        const terminal = ['FILLED', 'CANCELLED'];
        if (terminal.includes(order.status ?? '')) {
          this.stopPolling(orderId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.config.logger?.error('polymarket poll failed', { orderId, err: message });
      }
    };

    this.pollTimers.set(
      orderId,
      setTimeout(() => {
        void tick();
        const interval = setInterval(() => void tick(), 1000);
        this.pollTimers.set(orderId, interval);
      }, 200),
    );
  }

  private stopPolling(orderId: string): void {
    const timer = this.pollTimers.get(orderId);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.pollTimers.delete(orderId);
    }
  }

  private handleOrderUpdate(
    orderId: string,
    order: { status?: string; sizeMatched?: string; price?: string; size?: string },
    req: OrderRequest,
    onEvent: (event: GatewayOrderEvent) => void,
  ): void {
    const matched = Number(order.sizeMatched ?? 0);
    const prevMatched = this.reportedFilled.get(orderId) ?? 0;
    const delta = matched - prevMatched;

    if (delta > 0) {
      const priceUsd = order.price != null ? dec(order.price) : req.priceUsd;
      const sizeCoin = dec(delta);

      if (order.status === 'FILLED') {
        onEvent({ kind: 'fill', tsMs: Date.now(), priceUsd, sizeCoin });
      } else {
        onEvent({ kind: 'partial_fill', tsMs: Date.now(), priceUsd, sizeCoin });
      }
      this.reportedFilled.set(orderId, matched);
    }

    if (order.status === 'CANCELLED') {
      onEvent({ kind: 'cancel', tsMs: Date.now(), reason: 'cancelled by exchange or client' });
    }
  }

  private ensureAuthenticated(): Promise<ClobClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.clientPromise) return this.clientPromise;

    this.clientPromise = this.buildClient();
    return this.clientPromise;
  }

  private async buildClient(): Promise<ClobClient> {
    const key = normalizePrivateKey(this.config.privateKey);
    const account = privateKeyToAccount(key as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const unauthClient = new ClobClient({
      host: this.config.host ?? DEFAULT_HOST,
      chain: (this.config.chainId ?? POLYGON_CHAIN_ID) as Chain,
      signer: walletClient,
    });

    const creds = (await unauthClient.createOrDeriveApiKey()) as ApiKeyCreds;
    this.client = new ClobClient({
      host: this.config.host ?? DEFAULT_HOST,
      chain: (this.config.chainId ?? POLYGON_CHAIN_ID) as Chain,
      signer: walletClient,
      creds,
      throwOnError: true,
    });

    return this.client;
  }
}

function tokenIdFromInstrumentId(instrumentId: string): string {
  const idx = instrumentId.indexOf(':');
  return idx >= 0 ? instrumentId.slice(idx + 1) : instrumentId;
}

/**
 * Map the normalised TIF to a Polymarket order type. Arbitrage legs use FAK
 * (fill-and-kill = IOC): take whatever is marketable now, cancel the rest, so
 * no order ever rests on the book and strands the other leg. `gtc` is only for
 * deliberate resting orders. FOK maps to FAK when the SDK lacks a FOK type.
 */
function polymarketOrderType(tif: TimeInForce | undefined): OrderType {
  const types = OrderType as unknown as Record<string, OrderType>;
  if (tif === 'gtc') return OrderType.GTC;
  // Prefer FAK (IOC); fall back to GTC only if the SDK build lacks it.
  return types.FAK ?? types.FOK ?? OrderType.GTC;
}

function normalizePrivateKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}
