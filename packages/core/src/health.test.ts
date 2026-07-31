import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthRegistry, createHealthServer } from './health.js';

describe('HealthRegistry', () => {
  it('reports healthy when all checks pass', async () => {
    const registry = new HealthRegistry();
    registry.register('ok', () => ({ healthy: true }));
    const result = await registry.evaluate();
    expect(result.status).toBe('healthy');
    expect(result.checks.ok).toEqual({ healthy: true });
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
  });

  it('reports degraded when a non-critical check fails', async () => {
    const registry = new HealthRegistry();
    registry.register('ok', () => ({ healthy: true }));
    registry.register('stale', () => ({ healthy: false, message: 'stale' }), { critical: false });
    const result = await registry.evaluate();
    expect(result.status).toBe('degraded');
    expect(result.checks.stale).toEqual({ healthy: false, message: 'stale' });
  });

  it('reports unhealthy when a critical check fails', async () => {
    const registry = new HealthRegistry();
    registry.register('ok', () => ({ healthy: true }));
    registry.register('down', () => ({ healthy: false, message: 'down' }), { critical: true });
    const result = await registry.evaluate();
    expect(result.status).toBe('unhealthy');
  });

  it('evaluates only critical checks when criticalOnly is set', async () => {
    const registry = new HealthRegistry();
    registry.register('critical-ok', () => ({ healthy: true }), { critical: true });
    registry.register('noncritical-bad', () => ({ healthy: false, message: 'bad' }), {
      critical: false,
    });
    const result = await registry.evaluate({ criticalOnly: true });
    expect(result.status).toBe('healthy');
    expect(result.checks['noncritical-bad']).toBeUndefined();
  });

  it('treats thrown indicators as unhealthy', async () => {
    const registry = new HealthRegistry();
    registry.register('throws', () => {
      throw new Error('boom');
    });
    const result = await registry.evaluate();
    expect(result.status).toBe('degraded');
    expect(result.checks.throws).toEqual({ healthy: false, message: 'boom' });
  });
});

describe('createHealthServer', () => {
  let registry: HealthRegistry;
  let server: ReturnType<(typeof import('node:http'))['createServer']>;

  beforeEach(() => {
    registry = new HealthRegistry();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 200 and all checks on /health', async () => {
    registry.register('ok', () => ({ healthy: true }));
    registry.register('bad', () => ({ healthy: false, message: 'bad' }), { critical: true });
    server = await createHealthServer(registry, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
    expect(body.status).toBe('unhealthy');
    expect(body.checks.ok).toEqual({ healthy: true });
    expect(body.checks.bad).toEqual({ healthy: false, message: 'bad' });
  });

  it('returns 200 on /ready when critical checks pass', async () => {
    registry.register('ok', () => ({ healthy: true }), { critical: true });
    registry.register('bad', () => ({ healthy: false, message: 'bad' }), { critical: false });
    server = await createHealthServer(registry, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
    expect(body.status).toBe('healthy');
    expect(body.checks.ok).toEqual({ healthy: true });
    expect(body.checks.bad).toBeUndefined();
  });

  it('returns 503 on /ready when a critical check fails', async () => {
    registry.register('bad', () => ({ healthy: false, message: 'bad' }), { critical: true });
    server = await createHealthServer(registry, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('unhealthy');
  });

  it('returns 404 for unknown paths', async () => {
    registry.register('ok', () => ({ healthy: true }));
    server = await createHealthServer(registry, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});
