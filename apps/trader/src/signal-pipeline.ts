import type { Decimal, Logger } from '@optarb/core';
import type { MarketDataStore } from '@optarb/marketdata';
import { PaperExecutor, type ExecutionIntent, type PaperFill } from '@optarb/execution';
import { RiskEngine, riskStateFromSnapshot } from '@optarb/risk';
import type { AuditWriter } from '@optarb/persistence';

export interface SignalPipelineDeps {
  riskEngine: RiskEngine;
  executor: PaperExecutor;
  audit: AuditWriter;
  store: MarketDataStore;
  dailyRealizedPnl: (nowMs: number, cumulative: Decimal) => Decimal;
  dailyNetPnl: (nowMs: number, cumulative: Decimal) => Decimal;
  logger: Logger;
  logExecution: (signalId: string, outcome: string, fills: number) => void;
  logFill: (fill: PaperFill) => void;
  persistExecution: (intent: ExecutionIntent, fills: PaperFill[]) => Promise<void>;
}

export interface PipelineResult {
  executed: boolean;
  fillCount: number;
  riskDenied: boolean;
}

/**
 * Single risk → audit → execute pipeline shared by all signal kinds.
 * ADR-0006 requires EVERY risk decision (allow and deny) to be audited —
 * previously only denials were written.
 */
export async function processIntent(
  deps: SignalPipelineDeps,
  intent: ExecutionIntent,
  nowMs: number,
  killSwitchActive: boolean,
): Promise<PipelineResult> {
  const snapshot = deps.executor.portfolio.snapshot(deps.store.views());
  const dailyRealizedPnlUsd = deps.dailyRealizedPnl(nowMs, snapshot.realizedPnlUsd);
  const dailyNetPnlUsd = deps.dailyNetPnl(nowMs, snapshot.netPnlUsd);
  const riskState = riskStateFromSnapshot(snapshot, dailyRealizedPnlUsd, dailyNetPnlUsd);
  const riskResult = await deps.riskEngine.check(intent, riskState, nowMs, killSwitchActive);

  // Audit both outcomes (ADR-0006); fire-and-forget so audit downtime
  // never blocks the scan loop.
  void deps.audit
    .writeRiskDecision({
      signalId: intent.signalId,
      allowed: riskResult.allowed,
      reasons: riskResult.reasons,
      checkedAt: new Date(nowMs),
    })
    .catch(() => {});

  if (!riskResult.allowed) {
    deps.logger.warn('risk check denied intent', {
      signalId: intent.signalId,
      reasons: riskResult.reasons,
    });
    return { executed: false, fillCount: 0, riskDenied: true };
  }

  const outcome = deps.executor.execute(intent);
  const fills = outcome.status === 'executed' ? outcome.result.fills : [];
  deps.logExecution(
    intent.signalId,
    outcome.status === 'executed'
      ? `executed gross=${outcome.result.grossEdgeUsd.toFixed(2)} fees=${outcome.result.feesUsd.toFixed(2)} net=${outcome.result.netEdgeUsd.toFixed(2)}`
      : `skipped: ${outcome.reason}`,
    fills.length,
  );
  if (outcome.status === 'executed') {
    for (const fill of fills) deps.logFill(fill);
    void deps.persistExecution(intent, fills).catch(() => {});
    return { executed: true, fillCount: fills.length, riskDenied: false };
  }
  return { executed: false, fillCount: 0, riskDenied: false };
}
