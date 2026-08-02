import WebSocket from 'ws';
import type { ConnectorDeps } from './connector.js';
import type { ConnectorState, Venue } from './model.js';

export interface WsConnectorOptions {
  wsUrl: string;
  /** Extra WS handshake headers (e.g. User-Agent, x-simulated-trading for OKX demo) */
  headers?: Record<string, string>;
  /** App-level heartbeat cadence in ms; disabled when unset */
  heartbeatIntervalMs?: number;
  /** Force reconnect if no frame is read in this many ms; disabled when unset */
  readIdleTimeoutMs?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/**
 * Shared WebSocket lifecycle for venue connectors (ADR-0003): connect, raw capture
 * of every frame, app-level heartbeat, reconnect with exponential backoff + jitter.
 * Subclasses implement open handshake (auth/resubscribe) and message routing.
 */
export abstract class BaseWsConnector {
  abstract readonly venue: Venue;

  protected ws: WebSocket | null = null;
  protected state: ConnectorState = 'disconnected';

  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readIdleTimer: NodeJS.Timeout | null = null;
  private lastReadTs = 0;
  private connectPromise: Promise<void> | null = null;

  constructor(
    protected readonly options: WsConnectorOptions,
    protected readonly deps: ConnectorDeps,
  ) {}

  /** Called after the socket opens: authenticate + (re)subscribe here. */
  protected abstract onWsOpen(): void;
  /** Called for each parsed JSON message. */
  protected abstract onWsMessage(payload: unknown): void;
  /** Called for non-JSON text frames (e.g. OKX `pong`). */
  protected onWsText(_text: string): void {}
  /** App-level heartbeat payload; string = raw frame, object = JSON, undefined = skip. */
  protected heartbeatPayload(): unknown {
    return undefined;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.state = 'disconnected';
    ws?.close();
    this.emitStatus('disconnected', 'closed by client');
  }

  protected send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
    this.deps.capture.record({
      tsMs: this.deps.clock.nowMs(),
      venue: this.venue,
      channel: 'ws',
      direction: 'out',
      payload,
    });
  }

  protected sendRaw(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(text);
    this.deps.capture.record({
      tsMs: this.deps.clock.nowMs(),
      venue: this.venue,
      channel: 'ws',
      direction: 'out',
      payload: text,
    });
  }

  protected emitStatus(state: ConnectorState, detail?: string): void {
    this.deps.bus.emit('connector.status', {
      venue: this.venue,
      state,
      tsMs: this.deps.clock.nowMs(),
      detail,
    });
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      this.emitStatus('connecting');
      const ws = new WebSocket(this.options.wsUrl, { headers: this.options.headers });
      this.ws = ws;

      const onEarlyError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        ws.off('error', onEarlyError);
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this.lastReadTs = this.deps.clock.nowMs();
        this.emitStatus('connected');
        this.startHeartbeat();
        this.startReadIdleWatchdog();
        this.onWsOpen();
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onEarlyError);
      ws.on('message', (data: WebSocket.RawData) => this.handleFrame(data));
      ws.on('close', () => this.onClose());
      ws.on('error', (err) =>
        this.deps.logger.error(`${this.venue} ws error`, { err: String(err) }),
      );
    });
  }

  private handleFrame(data: WebSocket.RawData): void {
    this.lastReadTs = this.deps.clock.nowMs();
    const text = data.toString();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.onWsText(text);
      return;
    }
    this.deps.capture.record({
      tsMs: this.deps.clock.nowMs(),
      venue: this.venue,
      channel: 'ws',
      direction: 'in',
      payload,
    });
    try {
      this.onWsMessage(payload);
    } catch (err) {
      this.deps.logger.warn(`${this.venue}: message handling failed`, { err: String(err) });
    }
  }

  private onClose(): void {
    this.ws = null;
    this.stopHeartbeat();
    this.stopReadIdleWatchdog();
    const wasIntentional = this.intentionalClose;
    this.state = 'disconnected';
    this.emitStatus('disconnected', wasIntentional ? 'closed by client' : 'connection lost');
    if (!wasIntentional) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempt++;
    const base = this.options.baseReconnectDelayMs ?? 500;
    const max = this.options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(base * 2 ** attempt, max) + Math.floor(Math.random() * 500);
    this.emitStatus('reconnecting', `attempt ${attempt + 1} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => {
        // Next attempt is scheduled via onClose of the failed socket.
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatIntervalMs;
    if (!interval) return;
    this.heartbeatTimer = setInterval(() => {
      const payload = this.heartbeatPayload();
      if (payload === undefined) return;
      if (typeof payload === 'string') this.sendRaw(payload);
      else this.send(payload);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startReadIdleWatchdog(): void {
    this.stopReadIdleWatchdog();
    const timeout = this.options.readIdleTimeoutMs;
    if (!timeout) return;
    this.readIdleTimer = setInterval(
      () => {
        const idle = this.deps.clock.nowMs() - this.lastReadTs;
        if (idle >= timeout && this.ws) {
          this.deps.logger.warn(`${this.venue}: read-idle watchdog closing socket`, {
            idleMs: idle,
          });
          this.ws.terminate();
        }
      },
      Math.max(1000, Math.floor(timeout / 4)),
    );
  }

  private stopReadIdleWatchdog(): void {
    if (this.readIdleTimer) {
      clearInterval(this.readIdleTimer);
      this.readIdleTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    this.stopReadIdleWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
