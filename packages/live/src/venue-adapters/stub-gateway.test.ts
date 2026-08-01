import { describe, expect, it, vi } from 'vitest';
import { dec } from '@optarb/core';
import { StubOrderGateway } from './stub-gateway.js';
import type { OrderRequest } from '../order-gateway.js';

describe('StubOrderGateway', () => {
  it('immediately rejects any submitted order', async () => {
    const gateway = new StubOrderGateway('deribit');
    const onEvent = vi.fn();
    const req: OrderRequest = {
      venue: 'deribit',
      instrumentId: 'deribit:BTC-OPT',
      side: 'buy',
      sizeCoin: dec('1'),
      priceUsd: dec('1000'),
      signalId: 's:1',
      attemptId: 'a:1',
      legIndex: 0,
    };

    await gateway.submit(req, onEvent);

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]![0];
    expect(event.kind).toBe('reject');
    expect(event.reason).toContain('live trading not configured for deribit');
  });

  it('cancel is a no-op', async () => {
    const gateway = new StubOrderGateway('deribit');
    await expect(gateway.cancel('any-id')).resolves.toBeUndefined();
  });
});
