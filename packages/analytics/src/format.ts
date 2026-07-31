import { dec, type Decimal } from '@optarb/core';
import type {
  Comparison,
  DetectorMetrics,
  MetricDelta,
  Report,
  UnderlyingMetrics,
  VenueMetrics,
} from './types.js';

function fmtMoney(d: Decimal): string {
  return d.toFixed(2);
}

function fmtPct(d: Decimal | null): string {
  return d === null ? 'N/A' : `${d.toFixed(2)}%`;
}

function fmtBps(d: Decimal | null): string {
  return d === null ? 'N/A' : `${d.toFixed(4)} bps`;
}

function fmtRatio(d: Decimal | null): string {
  return d === null ? 'N/A' : d.toFixed(4);
}

function fmtDate(d?: Date): string {
  return d ? d.toISOString().slice(0, 10) : 'unbounded';
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push('Analytics Report');
  lines.push('================');
  lines.push(`Period: ${fmtDate(report.period.from)} → ${fmtDate(report.period.to)}`);
  lines.push('');
  lines.push('Summary');
  lines.push('-------');
  lines.push(`Total signals:        ${report.totalSignals}`);
  lines.push(`Total fills:          ${report.totalFills}`);
  lines.push(`Total risk rejects:   ${report.totalRiskRejects}`);
  lines.push(`Reject rate:          ${fmtPct(report.rejectRate)}`);
  lines.push(`Gross PnL:            ${fmtMoney(report.grossPnl)} USD`);
  lines.push(`Fees:                 ${fmtMoney(report.fees)} USD`);
  lines.push(`Net PnL:              ${fmtMoney(report.netPnl)} USD`);
  lines.push(`Avg PnL per fill:     ${fmtMoney(report.avgPnlPerFill)} USD`);
  lines.push(`Win rate:             ${fmtPct(report.winRate)}`);
  lines.push(`Avg edge after fees:  ${fmtBps(report.avgEdgeAfterFeesBps)}`);
  lines.push(`Max drawdown:         ${fmtMoney(report.maxDrawdown)} USD`);
  lines.push(`Sharpe:               ${fmtRatio(report.sharpe)}`);
  lines.push(`Horizon hit rate:     ${fmtPct(report.horizonHitRate)}`);
  lines.push('');

  lines.push('Per venue');
  lines.push('---------');
  lines.push(
    ['Venue', 'Fills', 'Gross notional', 'Fees', 'Net PnL'].map((h) => h.padEnd(16)).join(''),
  );
  for (const [venue, m] of Object.entries(report.perVenue)) {
    if (!m) continue;
    lines.push(
      [
        venue.padEnd(16),
        String(m.fills).padEnd(16),
        fmtMoney(m.grossNotionalUsd).padEnd(16),
        fmtMoney(m.feesUsd).padEnd(16),
        fmtMoney(m.netPnlUsd).padEnd(16),
      ].join(''),
    );
  }
  lines.push('');

  lines.push('Per underlying');
  lines.push('--------------');
  lines.push(
    ['Underlying', 'Fills', 'Gross notional', 'Fees', 'Net PnL'].map((h) => h.padEnd(16)).join(''),
  );
  for (const [underlying, m] of Object.entries(report.perUnderlying)) {
    if (!m) continue;
    lines.push(
      [
        underlying.padEnd(16),
        String(m.fills).padEnd(16),
        fmtMoney(m.grossNotionalUsd).padEnd(16),
        fmtMoney(m.feesUsd).padEnd(16),
        fmtMoney(m.netPnlUsd).padEnd(16),
      ].join(''),
    );
  }
  lines.push('');

  lines.push('Per detector');
  lines.push('------------');
  lines.push(
    [
      'Detector',
      'Signals',
      'Executed',
      'Rejected',
      'Fills',
      'Gross PnL',
      'Fees',
      'Net PnL',
      'Win rate',
    ]
      .map((h) => h.padEnd(14))
      .join(''),
  );
  for (const [kind, m] of Object.entries(report.perDetector)) {
    lines.push(
      [
        kind.padEnd(14),
        String(m.signals).padEnd(14),
        String(m.executed).padEnd(14),
        String(m.rejected).padEnd(14),
        String(m.fills).padEnd(14),
        fmtMoney(m.grossPnlUsd).padEnd(14),
        fmtMoney(m.feesUsd).padEnd(14),
        fmtMoney(m.netPnlUsd).padEnd(14),
        fmtPct(m.winRate).padEnd(14),
      ].join(''),
    );
  }

  return lines.join('\n');
}

function csvRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      const s = String(c);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(',');
}

export function reportToCsv(report: Report): string {
  const rows: string[] = [];
  rows.push(csvRow(['section', 'key', 'value']));
  rows.push(csvRow(['period', 'from', fmtDate(report.period.from)]));
  rows.push(csvRow(['period', 'to', fmtDate(report.period.to)]));
  rows.push(csvRow(['summary', 'totalSignals', report.totalSignals]));
  rows.push(csvRow(['summary', 'totalFills', report.totalFills]));
  rows.push(csvRow(['summary', 'totalRiskRejects', report.totalRiskRejects]));
  rows.push(csvRow(['summary', 'rejectRate', fmtPct(report.rejectRate)]));
  rows.push(csvRow(['summary', 'grossPnl', fmtMoney(report.grossPnl)]));
  rows.push(csvRow(['summary', 'fees', fmtMoney(report.fees)]));
  rows.push(csvRow(['summary', 'netPnl', fmtMoney(report.netPnl)]));
  rows.push(csvRow(['summary', 'avgPnlPerFill', fmtMoney(report.avgPnlPerFill)]));
  rows.push(csvRow(['summary', 'winRate', fmtPct(report.winRate)]));
  rows.push(csvRow(['summary', 'avgEdgeAfterFeesBps', fmtBps(report.avgEdgeAfterFeesBps)]));
  rows.push(csvRow(['summary', 'maxDrawdown', fmtMoney(report.maxDrawdown)]));
  rows.push(csvRow(['summary', 'sharpe', fmtRatio(report.sharpe)]));
  rows.push(csvRow(['summary', 'horizonHitRate', fmtPct(report.horizonHitRate)]));

  for (const [venue, m] of Object.entries(report.perVenue)) {
    if (!m) continue;
    rows.push(
      csvRow([
        'perVenue',
        venue,
        m.fills,
        fmtMoney(m.grossNotionalUsd),
        fmtMoney(m.feesUsd),
        fmtMoney(m.netPnlUsd),
      ]),
    );
  }
  for (const [underlying, m] of Object.entries(report.perUnderlying)) {
    if (!m) continue;
    rows.push(
      csvRow([
        'perUnderlying',
        underlying,
        m.fills,
        fmtMoney(m.grossNotionalUsd),
        fmtMoney(m.feesUsd),
        fmtMoney(m.netPnlUsd),
      ]),
    );
  }
  for (const [kind, m] of Object.entries(report.perDetector)) {
    rows.push(
      csvRow([
        'perDetector',
        kind,
        m.signals,
        m.executed,
        m.rejected,
        m.fills,
        fmtMoney(m.grossPnlUsd),
        fmtMoney(m.feesUsd),
        fmtMoney(m.netPnlUsd),
        fmtPct(m.winRate),
      ]),
    );
  }

  return rows.join('\n');
}

const COMPARABLE_METRICS = [
  'totalSignals',
  'totalFills',
  'totalRiskRejects',
  'grossPnl',
  'fees',
  'netPnl',
  'winRate',
  'avgEdgeAfterFeesBps',
  'maxDrawdown',
  'sharpe',
  'horizonHitRate',
] as const;

type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

function metricValue(report: Report, key: ComparableMetric): Decimal | null {
  switch (key) {
    case 'totalSignals':
      return dec(report.totalSignals);
    case 'totalFills':
      return dec(report.totalFills);
    case 'totalRiskRejects':
      return dec(report.totalRiskRejects);
    case 'grossPnl':
      return report.grossPnl;
    case 'fees':
      return report.fees;
    case 'netPnl':
      return report.netPnl;
    case 'winRate':
      return report.winRate;
    case 'avgEdgeAfterFeesBps':
      return report.avgEdgeAfterFeesBps;
    case 'maxDrawdown':
      return report.maxDrawdown;
    case 'sharpe':
      return report.sharpe;
    case 'horizonHitRate':
      return report.horizonHitRate;
    default:
      return null;
  }
}

export function comparePeriods(a: Report, b: Report): Comparison {
  const deltas: Record<string, MetricDelta> = {};
  for (const key of COMPARABLE_METRICS) {
    const av = metricValue(a, key);
    const bv = metricValue(b, key);
    const absolute = av === null || bv === null ? dec(0) : bv.sub(av);
    let percent: Decimal | null = null;
    if (av !== null && bv !== null && !av.isZero()) {
      percent = absolute.div(av).mul(100);
    }
    deltas[key] = { absolute, percent };
  }
  return {
    metrics: [...COMPARABLE_METRICS],
    a,
    b,
    deltas,
  };
}

export function formatComparison(comparison: Comparison): string {
  const lines: string[] = [];
  lines.push('Period Comparison');
  lines.push('-----------------');
  lines.push(['Metric', 'A', 'B', 'Delta', 'Delta %'].map((h) => h.padEnd(20)).join(''));
  for (const key of comparison.metrics) {
    const metricKey = key as ComparableMetric;
    const delta = comparison.deltas[key]!;
    const av = metricValue(comparison.a, metricKey);
    const bv = metricValue(comparison.b, metricKey);
    const fmt =
      key.toLowerCase().includes('rate') || key.toLowerCase().includes('sharpe')
        ? fmtRatio
        : fmtMoney;
    lines.push(
      [
        key.padEnd(20),
        (av === null ? 'N/A' : fmt(av)).padEnd(20),
        (bv === null ? 'N/A' : fmt(bv)).padEnd(20),
        fmtMoney(delta.absolute).padEnd(20),
        (delta.percent === null ? 'N/A' : `${delta.percent.toFixed(2)}%`).padEnd(20),
      ].join(''),
    );
  }
  return lines.join('\n');
}

export function reportToJson(report: Report): unknown {
  const serializeDecimal = (d: Decimal | null): string | null => (d === null ? null : d.toFixed(8));
  const serializeVenueMetrics = (m: VenueMetrics | undefined) =>
    m
      ? {
          fills: m.fills,
          grossNotionalUsd: serializeDecimal(m.grossNotionalUsd),
          feesUsd: serializeDecimal(m.feesUsd),
          netPnlUsd: serializeDecimal(m.netPnlUsd),
        }
      : null;
  const serializeUnderlyingMetrics = (m: UnderlyingMetrics | undefined) =>
    m
      ? {
          fills: m.fills,
          grossNotionalUsd: serializeDecimal(m.grossNotionalUsd),
          feesUsd: serializeDecimal(m.feesUsd),
          netPnlUsd: serializeDecimal(m.netPnlUsd),
        }
      : null;
  const serializeDetectorMetrics = (m: DetectorMetrics) => ({
    signals: m.signals,
    executed: m.executed,
    rejected: m.rejected,
    fills: m.fills,
    grossPnlUsd: serializeDecimal(m.grossPnlUsd),
    feesUsd: serializeDecimal(m.feesUsd),
    netPnlUsd: serializeDecimal(m.netPnlUsd),
    winRate: serializeDecimal(m.winRate),
  });

  return {
    period: {
      from: report.period.from?.toISOString() ?? null,
      to: report.period.to?.toISOString() ?? null,
    },
    totalSignals: report.totalSignals,
    totalFills: report.totalFills,
    totalRiskRejects: report.totalRiskRejects,
    rejectRate: serializeDecimal(report.rejectRate),
    grossPnl: serializeDecimal(report.grossPnl),
    fees: serializeDecimal(report.fees),
    netPnl: serializeDecimal(report.netPnl),
    avgPnlPerFill: serializeDecimal(report.avgPnlPerFill),
    winRate: serializeDecimal(report.winRate),
    avgEdgeAfterFeesBps: serializeDecimal(report.avgEdgeAfterFeesBps),
    maxDrawdown: serializeDecimal(report.maxDrawdown),
    sharpe: serializeDecimal(report.sharpe),
    perVenue: Object.fromEntries(
      Object.entries(report.perVenue).map(([k, m]) => [k, serializeVenueMetrics(m)]),
    ),
    perUnderlying: Object.fromEntries(
      Object.entries(report.perUnderlying).map(([k, m]) => [k, serializeUnderlyingMetrics(m)]),
    ),
    perDetector: Object.fromEntries(
      Object.entries(report.perDetector).map(([k, m]) => [k, serializeDetectorMetrics(m)]),
    ),
    horizonHitRate: serializeDecimal(report.horizonHitRate),
  };
}
