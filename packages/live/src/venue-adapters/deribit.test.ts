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
});
