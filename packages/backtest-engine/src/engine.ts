import {
  emitAll,
  InMemoryEventBus,
  noopLogger,
  VirtualClock,
  type Instrument,
  type Logger,
  type RawCapture,
} from '@optarb/core';
import { PaperExecutor } from '@optarb/execution';
import { MarketDataStore } from '@optarb/marketdata';
import { readCapture } from '@optarb/persistence';
import { RiskEngine, riskStateFromSnapshot } from '@optarb/risk';
import { CrossVenueDetector } from '@optarb/signals';
import { crossVenueIntent } from './intent-builder.js';
import { formatReport } from './report.js';
import type { BacktestOptions, BacktestResult } from './types.js';
import { makeVenueReplays } from './venue-replays.js';

export { formatReport };
export type { BacktestOptions, BacktestResult } from './types.js';

const DEFAULT_SCAN_INTERVAL_MS = 1_000;

/**
 * Deterministic backtest engine v1 (ADR-0004/0001): replays a JSONL capture
 * through the exact same marketdata → signals → risk → paper execution
 * pipeline used by the live trader, but on a virtual clock.
 */
export class BacktestEngine {
  private readonly log: Logger;

  constructor(logger?: Logger) {
    this.log = logger ?? noopLogger;
  }

  async run(options: BacktestOptions): Promise<BacktestResult> {
    const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;

    const bus = new InMemoryEventBus();
    const clock = new VirtualClock();
    const store = new MarketDataStore();
    const detector = new CrossVenueDetector(options.signalConfig);
    const executor = new PaperExecutor({
      maxNotionalUsd: options.paperMaxNotionalUsd,
      fees: options.feeSchedules,
    });
    const riskEngine = new RiskEngine(options.riskConfig, options.feeSchedules);

    bus.on('market.ticker', (t) => store.applyTicker(t));
    bus.on('market.book', (b) => store.applyBook(b));

    const replays = makeVenueReplays(() => clock.nowMs());
    const registeredInstruments = new Set<string>();

    let rawEntries = 0;
    let skippedEntries = 0;
    let gaps = 0;
    let signalsSeen = 0;
    let riskRejects = 0;
    let fills = 0;
    let firstTsMs: number | null = null;
    let lastTsMs = 0;
    let lastScanMs = 0;
    let lastReportMs = 0;

    const executedSignalKeys = new Set<string>();

    // Process capture entries grouped by timestamp so a scan sees the full
    // state of each capture-time instant.
    const pendingBucket: RawCapture[] = [];

    const flushBucket = async (bucketTsMs: number): Promise<void> => {
      clock.set(bucketTsMs);
      for (const entry of pendingBucket) {
        const replay = replays[entry.venue];
        if (!replay || entry.direction !== 'in') {
          skippedEntries++;
          continue;
        }
        try {
          const events = replay.handle(entry.payload);
          this.registerNewInstruments(store, replay.context.instruments, registeredInstruments);
          emitAll(bus, events);
        } catch (err) {
          if (replay.onGap(err)) {
            gaps++;
            this.log.warn('backtest: sequence gap, reset venue book', {
              venue: entry.venue,
              err: String(err),
              tsMs: bucketTsMs,
            });
          } else {
            skippedEntries++;
            this.log.debug('backtest: skipped malformed entry', {
              venue: entry.venue,
              err: String(err),
              tsMs: bucketTsMs,
            });
          }
        }
      }
      pendingBucket.length = 0;

      if (bucketTsMs - lastScanMs >= scanIntervalMs) {
        await this.scan(
          store,
          detector,
          riskEngine,
          executor,
          clock.nowMs(),
          executedSignalKeys,
          (seen) => (signalsSeen += seen),
          (rejects) => (riskRejects += rejects),
          (newFills) => (fills += newFills),
        );
        lastScanMs = bucketTsMs;
      }

      if (bucketTsMs - lastReportMs >= options.reportIntervalMs) {
        this.reportSnapshot(store, executor, bucketTsMs);
        lastReportMs = bucketTsMs;
      }
    };

    for await (const entry of readCapture(options.captureFile)) {
      rawEntries++;
      if (firstTsMs === null) firstTsMs = entry.tsMs;
      lastTsMs = entry.tsMs;

      if (pendingBucket.length > 0 && pendingBucket[0]!.tsMs !== entry.tsMs) {
        await flushBucket(pendingBucket[0]!.tsMs);
      }
      pendingBucket.push(entry);
    }

    if (pendingBucket.length > 0) {
      await flushBucket(pendingBucket[0]!.tsMs);
    }

    // Final scan at the end of the capture to catch any state that formed
    // after the last scheduled scan interval.
    if (lastTsMs > lastScanMs) {
      await this.scan(
        store,
        detector,
        riskEngine,
        executor,
        clock.nowMs(),
        executedSignalKeys,
        (seen) => (signalsSeen += seen),
        (rejects) => (riskRejects += rejects),
        (newFills) => (fills += newFills),
      );
    }

    const finalViews = store.views();
    const snapshot = executor.portfolio.snapshot(finalViews);

    return {
      rawEntries,
      skippedEntries,
      gaps,
      signalsSeen,
      riskRejects,
      fills,
      finalPortfolioSnapshot: snapshot,
      realizedPnl: snapshot.realizedPnlUsd,
      unrealizedPnl: snapshot.unrealizedPnlUsd,
      fees: snapshot.feesPaidUsd,
      netPnl: snapshot.netPnlUsd,
      durationMs: firstTsMs === null ? 0 : lastTsMs - firstTsMs,
    };
  }

  private registerNewInstruments(
    store: MarketDataStore,
    contextInstruments: Map<string, Instrument>,
    registered: Set<string>,
  ): void {
    for (const inst of contextInstruments.values()) {
      if (!registered.has(inst.id)) {
        store.registerInstrument(inst);
        registered.add(inst.id);
      }
    }
  }

  private async scan(
    store: MarketDataStore,
    detector: CrossVenueDetector,
    riskEngine: RiskEngine,
    executor: PaperExecutor,
    nowMs: number,
    executedKeys: Set<string>,
    addSignals: (n: number) => void,
    addRejects: (n: number) => void,
    addFills: (n: number) => void,
  ): Promise<void> {
    const views = store.views();
    const signals = detector.detect(views, nowMs);
    addSignals(signals.length);

    for (const signal of signals) {
      const dedupKey = `${signal.key}:${signal.buyVenue}->${signal.sellVenue}`;
      if (executedKeys.has(dedupKey)) continue;

      const view = store.getView(signal.key);
      if (!view) continue;
      const intent = crossVenueIntent(signal, view);
      if (!intent) continue;

      const snapshot = executor.portfolio.snapshot(views);
      const riskState = riskStateFromSnapshot(snapshot, snapshot.realizedPnlUsd);
      const riskResult = await riskEngine.check(intent, riskState, nowMs);
      if (!riskResult.allowed) {
        addRejects(1);
        this.log.debug('backtest: risk check denied intent', {
          signalId: intent.signalId,
          reasons: riskResult.reasons,
        });
        continue;
      }

      const outcome = executor.execute(intent);
      if (outcome.status === 'executed') {
        executedKeys.add(dedupKey);
        addFills(outcome.result.fills.length);
        this.log.debug('backtest: paper execution', {
          signalId: intent.signalId,
          grossEdgeUsd: outcome.result.grossEdgeUsd.toString(),
          feesUsd: outcome.result.feesUsd.toString(),
          netEdgeUsd: outcome.result.netEdgeUsd.toString(),
          fills: outcome.result.fills.length,
        });
      } else {
        this.log.debug('backtest: executor skipped intent', {
          signalId: intent.signalId,
          reason: outcome.reason,
        });
      }
    }
  }

  private reportSnapshot(store: MarketDataStore, executor: PaperExecutor, tsMs: number): void {
    const snap = executor.portfolio.snapshot(store.views());
    this.log.info('backtest: portfolio snapshot', {
      tsMs,
      openPositions: snap.openPositions,
      grossNotionalUsd: snap.grossNotionalUsd.toString(),
      realizedPnlUsd: snap.realizedPnlUsd.toString(),
      unrealizedPnlUsd: snap.unrealizedPnlUsd.toString(),
      feesPaidUsd: snap.feesPaidUsd.toString(),
      netPnlUsd: snap.netPnlUsd.toString(),
    });
  }
}
