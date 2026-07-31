import { createServer, type Server } from 'node:http';

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
}

export type HealthIndicator = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthCheckOptions {
  /** Critical checks make /ready fail when unhealthy. */
  critical?: boolean;
}

interface RegisteredCheck {
  name: string;
  indicator: HealthIndicator;
  critical: boolean;
}

export interface HealthEvaluation {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, HealthCheckResult>;
  ts: string;
}

/**
 * Central registry for component health indicators. Components register a function
 * that returns `{healthy, message?}`; the registry aggregates them into an overall
 * status for `/health` and `/ready` endpoints.
 */
export class HealthRegistry {
  private readonly checks: RegisteredCheck[] = [];

  register(name: string, indicator: HealthIndicator, options?: HealthCheckOptions): void {
    this.checks.push({ name, indicator, critical: options?.critical ?? false });
  }

  async evaluate(opts?: { criticalOnly?: boolean }): Promise<HealthEvaluation> {
    const checksToRun = opts?.criticalOnly ? this.checks.filter((c) => c.critical) : this.checks;
    const results: Record<string, HealthCheckResult> = {};

    let hasCriticalFailure = false;
    let hasNonCriticalFailure = false;

    for (const check of checksToRun) {
      try {
        const result = await check.indicator();
        results[check.name] = result;
        if (!result.healthy) {
          if (check.critical) hasCriticalFailure = true;
          else hasNonCriticalFailure = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[check.name] = { healthy: false, message };
        if (check.critical) hasCriticalFailure = true;
        else hasNonCriticalFailure = true;
      }
    }

    let status: HealthEvaluation['status'] = 'healthy';
    if (hasCriticalFailure) status = 'unhealthy';
    else if (hasNonCriticalFailure) status = 'degraded';

    return { status, checks: results, ts: new Date().toISOString() };
  }
}

function sendJson(
  res: InstanceType<(typeof import('node:http'))['ServerResponse']>,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Create an HTTP server exposing `/health` (all checks) and `/ready` (critical checks only).
 * Resolves once the server is listening.
 */
export async function createHealthServer(registry: HealthRegistry, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        status: 'unhealthy',
        checks: { error: { healthy: false, message: 'method not allowed' } },
        ts: new Date().toISOString(),
      });
      return;
    }

    if (req.url === '/health') {
      const eval_ = await registry.evaluate();
      sendJson(res, eval_.status === 'unhealthy' ? 503 : 200, eval_);
      return;
    }

    if (req.url === '/ready') {
      const eval_ = await registry.evaluate({ criticalOnly: true });
      sendJson(res, eval_.status === 'unhealthy' ? 503 : 200, eval_);
      return;
    }

    sendJson(res, 404, {
      status: 'unhealthy',
      checks: { error: { healthy: false, message: 'not found' } },
      ts: new Date().toISOString(),
    });
  });

  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
