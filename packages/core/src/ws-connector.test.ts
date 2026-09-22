import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { InMemoryEventBus } from './events.js';
import { LiveClock } from './clock.js';
import { noopLogger } from './logger.js';
import type { CaptureSink, RawCapture } from './capture.js';
import type { ConnectorStatus } from './model.js';
import { BaseWsConnector, type WsConnectorOptions } from './ws-connector.js';

class TestConnector extends BaseWsConnector {
  readonly venue = 'deribit' as const;
  opened = 0;
  messages: unknown[] = [];
  texts: string[] = [];

  constructor(options: WsConnectorOptions, deps: ConstructorParameters<typeof BaseWsConnector>[1]) {
    super(options, deps);
  }

  protected onWsOpen(): void {
    this.opened++;
  }

  protected onWsMessage(payload: unknown): void {
    this.messages.push(payload);
  }

  protected override onWsText(text: string): void {
    this.texts.push(text);
  }

  protected override heartbeatPayload(): unknown {
    return { op: 'ping' };
  }
}

function makeCapture() {
  const entries: RawCapture[] = [];
  const sink: CaptureSink = {
    record: (e) => {
      entries.push(e);
    },
    close: async () => {},
  };
  return { entries, sink };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('BaseWsConnector', () => {
  let server: WebSocketServer | null = null;
  let serverReceived: string[] = [];
  let url = '';

  beforeEach(async () => {
    serverReceived = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    url = `ws://127.0.0.1:${port}`;
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        serverReceived.push(data.toString());
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.clients.forEach((c) => c.terminate());
      server.close(() => resolve());
      server = null;
    });
  });

  function makeConnector(options?: Partial<WsConnectorOptions>) {
    const bus = new InMemoryEventBus();
    const statuses: ConnectorStatus[] = [];
    bus.on('connector.status', (s) => {
      statuses.push(s);
    });
    const { entries, sink } = makeCapture();
    const connector = new TestConnector(
      { wsUrl: url, heartbeatIntervalMs: 50, ...options },
      { bus, clock: new LiveClock(), capture: sink, logger: noopLogger },
    );
    return { connector, statuses, entries };
  }

  it('connects, runs the open handshake and routes JSON messages', async () => {
    const { connector, statuses, entries } = makeConnector();
    await connector.connect();
    expect(connector.opened).toBe(1);
    expect(statuses.some((s) => s.state === 'connected')).toBe(true);

    server!.clients.forEach((c) => c.send(JSON.stringify({ hello: 'world' })));
    await waitFor(() => connector.messages.length === 1);
    expect(connector.messages[0]).toEqual({ hello: 'world' });
    expect(entries.some((e) => e.direction === 'in')).toBe(true);

    await connector.disconnect();
  });

  it('routes non-JSON text frames to onWsText', async () => {
    const { connector } = makeConnector();
    await connector.connect();
    server!.clients.forEach((c) => c.send('pong'));
    await waitFor(() => connector.texts.length === 1);
    expect(connector.texts[0]).toBe('pong');
    await connector.disconnect();
  });

  it('sends the app-level heartbeat on schedule', async () => {
    const { connector } = makeConnector({ heartbeatIntervalMs: 50 });
    await connector.connect();
    await waitFor(() => serverReceived.length >= 1);
    expect(JSON.parse(serverReceived[0]!)).toEqual({ op: 'ping' });
    await connector.disconnect();
  });

  it('reconnects with backoff after the server drops the connection', async () => {
    const { connector, statuses } = makeConnector({
      baseReconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
    });
    await connector.connect();
    const openedOnce = connector.opened;
    expect(openedOnce).toBe(1);

    // Drop the connection server-side; the client must notice and reconnect.
    server!.clients.forEach((c) => c.terminate());
    await waitFor(() => connector.opened >= 2);
    expect(statuses.some((s) => s.state === 'reconnecting')).toBe(true);
    await connector.disconnect();
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const { connector, statuses } = makeConnector({
      baseReconnectDelayMs: 50,
      maxReconnectDelayMs: 100,
    });
    await connector.connect();
    const atDisconnect = statuses.length;
    await connector.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    // Only terminal 'disconnected' statuses are allowed after disconnect —
    // never 'reconnecting'/'connecting', and no second open handshake.
    const tail = statuses.slice(atDisconnect);
    expect(tail.length).toBeGreaterThanOrEqual(1);
    expect(tail.every((s) => s.state === 'disconnected')).toBe(true);
    expect(connector.opened).toBe(1);
  });
});
