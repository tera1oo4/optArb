import type { BacktestResult } from './types.js';

/** CLI-friendly multi-line report for a backtest run. */
export function formatReport(result: BacktestResult): string {
  const snap = result.finalPortfolioSnapshot;
  return [
    'Backtest Report',
    '===============',
    `Raw entries:      ${result.rawEntries}`,
    `Skipped entries:  ${result.skippedEntries}`,
    `Sequence gaps:    ${result.gaps}`,
    `Signals seen:     ${result.signalsSeen}`,
    `Risk rejects:     ${result.riskRejects}`,
    `Fills:            ${result.fills}`,
    `Duration (capture): ${result.durationMs} ms`,
    '',
    'Portfolio',
    '---------',
    `Open positions:   ${snap.openPositions}`,
    `Gross notional:   ${snap.grossNotionalUsd.toFixed(2)} USD`,
    `Realized PnL:     ${result.realizedPnl.toFixed(2)} USD`,
    `Unrealized PnL:   ${result.unrealizedPnl.toFixed(2)} USD`,
    `Fees paid:        ${result.fees.toFixed(2)} USD`,
    `Net PnL:          ${result.netPnl.toFixed(2)} USD`,
  ].join('\n');
}
