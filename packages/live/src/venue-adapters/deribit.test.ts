import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dec, type Decimal } from '@optarb/core';
import { DeribitOrderGateway } from './deribit.js';
import type { OrderRequest } from '../order-gateway.js';

function makeReq(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    venue: 'deribit',
    instrumentId: 'deribit:BTC-27JUN25-100000-C',
    side: 'buy',
    sizeCoin: dec('0.5'),
    priceUsd: dec('500'),
    indexPriceUsd: dec('100000'),
    contractMultiplier: dec('0.1'),
    signalId: 's:1',
    attemptId: 'a:1',
    legIndex: 0,
    ...overrides,
  };
}

describe('DeribitOrderGateway', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('rejects on authentication failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 13004, message: 'invalid_credentials' },
      }),
    });

    const gw = new DeribitOrderGateway({ clientId: 'bad', clientSecret: 'bad' });
    const events: Array<{ kind: string; reason?: string }> = [];
    await gw.submit(makeReq(), (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('reject');
    expect(events[0]!.reason).toContain('invalid_credentials');
  });

  it('emits ack then fill when the order is filled', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: {
            order: {
              order_id: 'deribit-123',
              instrument_name: 'BTC-27JUN25-100000-C',
              amount: 5,
              filled_amount: 0,
              average_price: 0,
              order_state: 'open',
            },
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 3,
          result: {
            order: {
              order_id: 'deribit-123',
              instrument_name: 'BTC-27JUN25-100000-C',
              amount: 5,
              filled_amount: 5,
              average_price: 0.005,
              order_state: 'filled',
            },
          },
        }),
      });

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    const events: Array<{ kind: string; priceUsd?: Decimal; sizeCoin?: Decimal }> = [];
    await gw.submit(makeReq(), (e) => events.push(e));

    expect(events[0]!.kind).toBe('ack');

    // Poll starts after 200ms and then every 1s.
    await vi.advanceTimersByTimeAsync(1300);

    expect(events.some((e) => e.kind === 'fill')).toBe(true);
    const fill = events.find((e) => e.kind === 'fill')!;
    // average_price 0.005 BTC * index 100k = 500 USD; 5 contracts * 0.1 = 0.5 coin
    expect(fill.priceUsd!.toString()).toBe('500');
    expect(fill.sizeCoin!.toString()).toBe('0.5');
  });

  it('calls private/cancel on cancel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: { order_state: 'cancelled' } }),
      });
    globalThis.fetch = fetchMock;

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    await gw.cancel('deribit-123');

    expect(fetchMock).toHaveBeenCalled();
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const url = lastCall![0] as string;
    expect(url).toContain('private/cancel');
  });

  it('sends the auth token in the Authorization header, not the URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'sekrit-token', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 2, result: { order_state: 'cancelled' } }),
      });
    globalThis.fetch = fetchMock;

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    await gw.cancel('deribit-123');

    const authedCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const url = authedCall[0] as string;
    const init = authedCall[1] as { headers: Record<string, string> };
    expect(url).not.toContain('token=');
    expect(url).not.toContain('sekrit-token');
    expect(init.headers.Authorization).toBe('Bearer sekrit-token');
  });

  it('rounds the amount down to the min-trade-amount step from metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: { order: { order_id: 'o1', order_state: 'open', filled_amount: 0 } },
        }),
      });
    globalThis.fetch = fetchMock;

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    // rawContracts = 0.47 / 0.1 = 4.7 → floor to 0.1 step → 4.6 contracts.
    await gw.submit(
      makeReq({
        sizeCoin: dec('0.47'),
        contractMultiplier: dec('0.1'),
        metadata: { minTradeAmount: '0.1', tickSize: '0.0005' },
      }),
      () => {},
    );

    const placeCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('private/place_order'),
    )!;
    const body = JSON.parse((placeCall[1] as { body: string }).body);
    expect(body.params.amount).toBe(4.6);
  });

  it('rejects an order below the min trade amount', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
      }),
    });

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    const events: Array<{ kind: string; reason?: string }> = [];
    // rawContracts = 0.05 / 1 = 0.05 < min 0.1 → reject.
    await gw.submit(
      makeReq({
        sizeCoin: dec('0.05'),
        contractMultiplier: dec('1'),
        metadata: { minTradeAmount: '0.1' },
      }),
      (e) => events.push(e),
    );

    expect(events.some((e) => e.kind === 'reject' && /min/.test(e.reason ?? ''))).toBe(true);
  });

  it('snaps a buy limit price up to the tick size', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: { order: { order_id: 'o1', order_state: 'open', filled_amount: 0 } },
        }),
      });
    globalThis.fetch = fetchMock;

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    // priceCoin = 530 / 100000 = 0.0053 → buy rounds UP to 0.0055 tick.
    await gw.submit(
      makeReq({
        side: 'buy',
        priceUsd: dec('530'),
        indexPriceUsd: dec('100000'),
        metadata: { tickSize: '0.0005', minTradeAmount: '0.1' },
      }),
      () => {},
    );

    const placeCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('private/place_order'),
    )!;
    const body = JSON.parse((placeCall[1] as { body: string }).body);
    expect(body.params.price).toBe(0.0055);
  });

  it('reports commission as feeUsd on the fill', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: { order: { order_id: 'deribit-123', order_state: 'open', filled_amount: 0 } },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 3,
          result: {
            order: {
              order_id: 'deribit-123',
              order_state: 'filled',
              filled_amount: 5,
              average_price: 0.005,
              commission: 0.0000375,
            },
          },
        }),
      });

    const gw = new DeribitOrderGateway({ clientId: 'id', clientSecret: 'secret' });
    const events: Array<{ kind: string; feeUsd?: Decimal }> = [];
    await gw.submit(makeReq(), (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(1300);

    const fill = events.find((e) => e.kind === 'fill')!;
    // commission 0.0000375 BTC * index 100k = 3.75 USD.
    expect(fill.feeUsd!.toString()).toBe('3.75');
  });
});
