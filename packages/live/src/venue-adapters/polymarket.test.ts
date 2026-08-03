import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dec } from '@optarb/core';
import { PolymarketOrderGateway } from './polymarket.js';
import type { OrderRequest } from '../order-gateway.js';

const DUMMY_PRIVATE_KEY = '0x' + '1'.repeat(64);

const mockClient = {
  createOrDeriveApiKey: vi.fn().mockResolvedValue({ key: 'k', secret: 's', passphrase: 'p' }),
  createAndPostOrder: vi.fn().mockResolvedValue({
    success: true,
    orderID: 'order-123',
    errorMsg: '',
  }),
  cancelOrder: vi.fn().mockResolvedValue({ canceled: true }),
  getOrder: vi.fn().mockResolvedValue({ status: 'FILLED', sizeMatched: '5', price: '0.5' }),
};

vi.mock('@polymarket/clob-client-v2', () => {
  return {
    ClobClient: vi.fn().mockImplementation(() => mockClient),
    OrderType: { GTC: 'GTC' },
    Side: { BUY: 'BUY', SELL: 'SELL' },
    Chain: { POLYGON: 137 },
  };
});

function baseReq(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    venue: 'polymarket',
    instrumentId: 'polymarket:token-abc',
    side: 'buy',
    sizeCoin: dec(5),
    priceUsd: dec(0.45),
    metadata: { tickSize: '0.001', negRisk: 'false' },
    signalId: 'sig-1',
    attemptId: 'att-1',
    legIndex: 0,
    ...overrides,
  };
}

describe('PolymarketOrderGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits a GTC order and emits ack + fill', async () => {
    const gw = new PolymarketOrderGateway({ privateKey: DUMMY_PRIVATE_KEY });
    const events: { kind: string; exchangeOrderId?: string }[] = [];

    await gw.submit(baseReq(), (e) =>
      events.push({
        kind: e.kind,
        exchangeOrderId: (e as { exchangeOrderId?: string }).exchangeOrderId,
      }),
    );

    await new Promise((r) => setTimeout(r, 300));

    expect(mockClient.createAndPostOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenID: 'token-abc', side: 'BUY', price: 0.45, size: 5 }),
      expect.objectContaining({ tickSize: '0.001', negRisk: false }),
      'GTC',
    );
    expect(events.some((e) => e.kind === 'ack' && e.exchangeOrderId === 'order-123')).toBe(true);
    expect(events.some((e) => e.kind === 'fill')).toBe(true);
  });

  it('emits reject for invalid price', async () => {
    const gw = new PolymarketOrderGateway({ privateKey: DUMMY_PRIVATE_KEY });
    const events: { kind: string }[] = [];

    await gw.submit(baseReq({ priceUsd: dec(1.1) }), (e) => events.push({ kind: e.kind }));

    expect(events.some((e) => e.kind === 'reject')).toBe(true);
  });

  it('cancels an order', async () => {
    const gw = new PolymarketOrderGateway({ privateKey: DUMMY_PRIVATE_KEY });

    await gw.cancel('order-123');

    expect(mockClient.cancelOrder).toHaveBeenCalledWith({ orderID: 'order-123' });
  });
});
