import { dec, type Decimal, type Logger, type Venue } from '@optarb/core';
import type { GatewayOrderEvent, OrderGateway, OrderRequest } from '../order-gateway.js';

export interface DeribitGatewayConfig {
  clientId: string;
  clientSecret: string;
  testnet?: boolean;
  logger?: Logger;
}

interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Deribit testnet/live REST order gateway.
 *
 * Uses Deribit's JSON-RPC HTTP API:
 *   - public/auth (client_credentials)
 *   - private/place_order
 *   - private/cancel
 *   - private/get_order_state (polled until terminal)
 *
 * USD-denominated OMS prices are converted to the underlying coin price using
 * the index price, and sizeCoin is converted to integer contracts using the
 * instrument multiplier.
 */
export class DeribitOrderGateway implements OrderGateway {
  readonly venue: Venue = 'deribit';
  private readonly config: DeribitGatewayConfig;
  private readonly baseUrl: string;
  private token: Token | null = null;
  private requestId = 0;
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportedFilled = new Map<string, Decimal>();

  constructor(config: DeribitGatewayConfig) {
    this.config = config;
    this.baseUrl =
      config.testnet !== false
        ? 'https://test.deribit.com/api/v2'
        : 'https://www.deribit.com/api/v2';
  }

  async submit(req: OrderRequest, onEvent: (event: GatewayOrderEvent) => void): Promise<void> {
    try {
      await this.ensureAuthenticated();

      if (!req.indexPriceUsd || req.indexPriceUsd.isZero()) {
        throw new Error('missing indexPriceUsd for deribit order');
      }
      if (!req.contractMultiplier || req.contractMultiplier.isZero()) {
        throw new Error('missing contractMultiplier for deribit order');
      }

      const instrumentName = venueSymbolOf(req.instrumentId);
      const amountContracts = req.sizeCoin.div(req.contractMultiplier).toDecimalPlaces(0);
      if (amountContracts.lte(0)) {
        throw new Error(`invalid amount ${amountContracts.toString()} for ${instrumentName}`);
      }

      // Deribit option prices are denominated in the underlying coin.
      const priceCoin = req.priceUsd.div(req.indexPriceUsd);

      const params: Record<string, unknown> = {
        instrument_name: instrumentName,
        side: req.side,
        amount: amountContracts.toNumber(),
        price: priceCoin.toNumber(),
        type: 'limit',
        label: `optarb:${req.signalId}`,
      };

      const res = await this.call('private/place_order', params);
      const order = parseOrder(res);
      const orderId = order.order_id;
      if (!orderId) {
        throw new Error('place_order response missing order_id');
      }

      onEvent({
        kind: 'ack',
        tsMs: Date.now(),
        exchangeOrderId: orderId,
      });

      this.startPolling(orderId, instrumentName, req, onEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.config.logger?.error('deribit submit failed', {
        instrumentId: req.instrumentId,
        err: message,
      });
      onEvent({ kind: 'reject', tsMs: Date.now(), reason: message });
    }
  }

  async cancel(exchangeOrderId: string): Promise<void> {
    this.stopPolling(exchangeOrderId);
    await this.ensureAuthenticated();
    await this.call('private/cancel', { order_id: exchangeOrderId });
  }

  private startPolling(
    orderId: string,
    instrumentName: string,
    req: OrderRequest,
    onEvent: (event: GatewayOrderEvent) => void,
  ): void {
    this.stopPolling(orderId);

    const tick = async () => {
      try {
        await this.ensureAuthenticated();
        const res = await this.call('private/get_order_state', { order_id: orderId });
        const order = parseOrder(res);
        this.handleOrderUpdate(orderId, order, req, onEvent);

        const state = order.order_state;
        if (state === 'filled' || state === 'cancelled' || state === 'rejected') {
          this.stopPolling(orderId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.config.logger?.error('deribit poll failed', { orderId, err: message });
        // Do not stop polling on transient errors; rely on timeout/kill-switch.
      }
    };

    // Initial quick check, then every second.
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
    order: DeribitOrder,
    req: OrderRequest,
    onEvent: (event: GatewayOrderEvent) => void,
  ): void {
    const filledAmount = dec(order.filled_amount ?? 0);
    const prevFilled = this.reportedFilled.get(orderId) ?? dec(0);
    const delta = filledAmount.sub(prevFilled);

    if (delta.gt(0)) {
      const avgPriceCoin = order.average_price != null ? dec(order.average_price) : null;
      const priceUsd =
        avgPriceCoin && req.indexPriceUsd && !req.indexPriceUsd.isZero()
          ? avgPriceCoin.mul(req.indexPriceUsd)
          : req.priceUsd;

      const eventBase = {
        tsMs: Date.now(),
        priceUsd,
        sizeCoin: delta.mul(req.contractMultiplier ?? 1),
      };

      if (order.order_state === 'filled') {
        onEvent({ kind: 'fill', ...eventBase });
      } else {
        onEvent({ kind: 'partial_fill', ...eventBase });
      }

      this.reportedFilled.set(orderId, filledAmount);
    }

    if (order.order_state === 'cancelled') {
      onEvent({ kind: 'cancel', tsMs: Date.now(), reason: 'cancelled by exchange or client' });
    } else if (order.order_state === 'rejected') {
      onEvent({ kind: 'reject', tsMs: Date.now(), reason: 'order rejected by exchange' });
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return;

    const result = (await this.rpc('public/auth', {
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    })) as
      | {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        }
      | undefined;
    if (!result?.access_token) {
      throw new Error('deribit auth failed: no access_token');
    }

    this.token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? '',
      expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
    };
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.token) throw new Error('not authenticated');
    return this.rpc(method, params, this.token.accessToken);
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    token?: string,
  ): Promise<unknown> {
    const id = ++this.requestId;
    const body: RpcRequest = { jsonrpc: '2.0', id, method, params };
    const url = token
      ? `${this.baseUrl}/${method}?token=${encodeURIComponent(token)}`
      : `${this.baseUrl}/${method}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`deribit HTTP ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as RpcResponse;
    if (json.error) {
      throw new Error(`deribit RPC ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }
}

interface DeribitOrder {
  order_id: string;
  order_state: 'open' | 'filled' | 'cancelled' | 'rejected';
  filled_amount: number;
  average_price: number | null;
}

function parseOrder(result: unknown): DeribitOrder {
  const r = result as Record<string, unknown> | undefined;
  const order = (r?.order as Record<string, unknown> | undefined) ?? r ?? {};
  return {
    order_id: String(order.order_id ?? ''),
    order_state: String(order.order_state ?? 'open') as DeribitOrder['order_state'],
    filled_amount: Number(order.filled_amount ?? 0),
    average_price: order.average_price != null ? Number(order.average_price) : null,
  };
}

function venueSymbolOf(instrumentId: string): string {
  const idx = instrumentId.indexOf(':');
  return idx >= 0 ? instrumentId.slice(idx + 1) : instrumentId;
}
