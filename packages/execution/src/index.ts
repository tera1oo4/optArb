/**
 * @optarb/execution — PAPER EXECUTION ONLY.
 *
 * Hard invariant (ADR-0006): this package simulates fills against real book
 * prices. It contains NO order-placement code paths, imports no venue order
 * APIs, and must never gain them. Live execution, when it ever ships, will be
 * a separate gated component. Use `@optarb/live` (M12) for the live order-gateway
 * wiring; it is enabled only by LIVE_TRADING=true + operator confirmation.
 *
 * Contents:
 * - fees.ts                — per-venue FeeSchedule (option min(rate×index, cap×premium)
 *                            model + Polymarket p(1−p) binary model) with sources
 * - paper-executor.ts      — PaperExecutor: intent → taker fills at top-of-book,
 *                            fee-deducted edge; optional OMS mode (M9)
 * - paper-portfolio.ts     — PaperPortfolio: average-cost positions, realized and
 *                            mark-to-market unrealized PnL, exposure snapshot
 * - oms-engine.ts          — two-legged order state machine + leg-risk control
 * - oms-types.ts           — OrderStatus, OrderAttempt, OrderCommandSender, etc.
 * - paper-order-simulator.ts — paper-only OrderCommandSender implementation
 */
export { DEFAULT_FEE_SCHEDULES, computeFeeUsd, resolveFeeSchedules } from './fees.js';
export type {
  BinaryFeeSchedule,
  FeeContext,
  FeeOverride,
  FeeSchedule,
  FeeSchedules,
  OptionFeeSchedule,
  OrderRole,
} from './fees.js';
export { OmsEngine } from './oms-engine.js';
export type {
  LegOrder,
  LegOrderHistoryEntry,
  OmsEngineConfig,
  OmsStats,
  OrderAttempt,
  OrderCommandSender,
  OrderEvent,
  OrderStatus,
} from './oms-types.js';
export { PaperExecutor } from './paper-executor.js';
export type { PaperExecutorConfig } from './paper-executor.js';
export { PaperOrderSimulator } from './paper-order-simulator.js';
export type { PaperOrderSimulatorConfig } from './paper-order-simulator.js';
export { PaperPortfolio } from './paper-portfolio.js';
export type {
  ExposureReport,
  PaperPosition,
  PortfolioSnapshot,
  PositionReport,
} from './paper-portfolio.js';
export type {
  ExecutionIntent,
  ExecutionLeg,
  ExecutionOutcome,
  ExecutionResult,
  PaperFill,
} from './types.js';
