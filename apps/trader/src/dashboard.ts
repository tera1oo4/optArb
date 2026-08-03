import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger, Venue, ConnectorStatus } from '@optarb/core';

export interface RecentSignal {
  tsMs: number;
  kind: string;
  key: string;
  buy?: string;
  sell?: string;
  spreadBps?: number | string;
  sizeUsd?: number | string;
  extra?: Record<string, unknown>;
}

export interface DashboardState {
  venues: Venue[];
  statuses: Map<Venue, ConnectorStatus>;
  lastMessageTs: Map<Venue, number>;
  lastScanTs: number;
  instrumentCount: number;
  recentSignals: RecentSignal[];
  latestPortfolioSummary: Record<string, unknown> | null;
  latestStats: Record<string, unknown> | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const MAX_SIGNALS = 50;

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

export function pushSignal(state: DashboardState, signal: RecentSignal): void {
  state.recentSignals.push(signal);
  if (state.recentSignals.length > MAX_SIGNALS) {
    state.recentSignals.shift();
  }
}

export function createDashboardHandler(
  state: DashboardState,
  evaluateHealth: () => Promise<{ status: string; checks: Record<string, unknown> }>,
  logger?: Logger,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? '/';

    if (url === '/' || url === '/index.html') {
      try {
        const html = await readFile(resolve(PUBLIC_DIR, 'index.html'), 'utf-8');
        sendText(res, 200, html, 'text/html');
        return true;
      } catch (err) {
        logger?.error('dashboard: failed to read index.html', { err: String(err) });
        sendJson(res, 500, { error: 'failed to read index.html' });
        return true;
      }
    }

    if (url === '/dashboard.css') {
      try {
        const css = await readFile(resolve(PUBLIC_DIR, 'dashboard.css'), 'utf-8');
        sendText(res, 200, css, 'text/css');
        return true;
      } catch {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
    }

    if (url === '/dashboard.js') {
      try {
        const js = await readFile(resolve(PUBLIC_DIR, 'dashboard.js'), 'utf-8');
        sendText(res, 200, js, 'application/javascript');
        return true;
      } catch {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
    }

    if (url === '/api/status') {
      const health = await evaluateHealth();
      const lastMessageAges: Record<string, string> = {};
      for (const venue of state.venues) {
        const ts = state.lastMessageTs.get(venue);
        lastMessageAges[venue] = ts ? `${Date.now() - ts}ms ago` : 'never';
      }
      sendJson(res, 200, {
        status: health.status,
        checks: health.checks,
        venues: state.venues,
        lastScanTs: state.lastScanTs || null,
        lastMessageAges,
        instrumentCount: state.instrumentCount,
      });
      return true;
    }

    if (url === '/api/signals') {
      sendJson(res, 200, { recent: state.recentSignals });
      return true;
    }

    if (url === '/api/portfolio') {
      sendJson(res, 200, state.latestPortfolioSummary ?? { message: 'no data yet' });
      return true;
    }

    if (url === '/api/logs') {
      sendJson(res, 200, {
        stats: state.latestStats ?? null,
        portfolioSummary: state.latestPortfolioSummary ?? null,
      });
      return true;
    }

    return false;
  };
}
