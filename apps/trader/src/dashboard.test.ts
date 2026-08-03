import { describe, expect, it, vi } from 'vitest';
import { createDashboardHandler, pushSignal } from './dashboard.js';
import type { DashboardState } from './dashboard.js';

function mockRes() {
  const end = vi.fn();
  return {
    writeHead: vi.fn(),
    end,
    _body: () => end.mock.calls[0]?.[0] as string,
  } as unknown as import('node:http').ServerResponse & { _body: () => string };
}

function createState(): DashboardState {
  return {
    venues: ['deribit', 'okx'],
    statuses: new Map(),
    lastMessageTs: new Map(),
    lastScanTs: 1_000,
    instrumentCount: 42,
    recentSignals: [],
    latestPortfolioSummary: null,
    latestStats: null,
  };
}

describe('createDashboardHandler', () => {
  it('serves the dashboard HTML at /', async () => {
    const handler = createDashboardHandler(createState(), async () => ({
      status: 'healthy',
      checks: {},
    }));
    const res = mockRes();
    const handled = await handler({ url: '/' } as import('node:http').IncomingMessage, res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
  });

  it('returns JSON status at /api/status', async () => {
    const handler = createDashboardHandler(createState(), async () => ({
      status: 'healthy',
      checks: { venue: { healthy: true } },
    }));
    const res = mockRes();
    const handled = await handler(
      { url: '/api/status' } as import('node:http').IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    const body = JSON.parse(res._body());
    expect(body.status).toBe('healthy');
    expect(body.venues).toEqual(['deribit', 'okx']);
    expect(body.instrumentCount).toBe(42);
  });

  it('returns recent signals at /api/signals', async () => {
    const state = createState();
    pushSignal(state, {
      tsMs: 1000,
      kind: 'cross-venue',
      key: 'BTC:...:call',
      buy: 'deribit @ 1',
      sell: 'okx @ 2',
      spreadBps: '100',
    });
    const handler = createDashboardHandler(state, async () => ({ status: 'healthy', checks: {} }));
    const res = mockRes();
    await handler({ url: '/api/signals' } as import('node:http').IncomingMessage, res);
    const body = JSON.parse(res._body());
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0].kind).toBe('cross-venue');
  });

  it('passes unknown URLs through', async () => {
    const handler = createDashboardHandler(createState(), async () => ({
      status: 'healthy',
      checks: {},
    }));
    const res = mockRes();
    const handled = await handler(
      { url: '/not-found' } as import('node:http').IncomingMessage,
      res,
    );
    expect(handled).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});
