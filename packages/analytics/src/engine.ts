import { computeReport } from './metrics.js';
import type { PeriodFilter, Report, TradeLog } from './types.js';

export class AnalyticsEngine {
  constructor(private readonly log: TradeLog) {}

  async computeReport(period?: PeriodFilter): Promise<Report> {
    const [orders, fills, decisions, snapshots] = await Promise.all([
      this.log.getOrders(),
      this.log.getFills(),
      this.log.getRiskDecisions(),
      this.log.getPortfolioSnapshots(),
    ]);
    return computeReport({ orders, fills, decisions, snapshots, period });
  }
}
