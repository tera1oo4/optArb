import type { Decimal } from '@optarb/core';

/** Returns a PnL delta since UTC midnight, resetting the baseline at day boundary. */
function createDailyPnlTracker(initialPnlUsd: Decimal) {
  let baseline = initialPnlUsd;
  let baselineDay = new Date().getUTCDate();
  return (nowMs: number, totalPnlUsd: Decimal): Decimal => {
    const currentDay = new Date(nowMs).getUTCDate();
    if (currentDay !== baselineDay) {
      baseline = totalPnlUsd;
      baselineDay = currentDay;
    }
    return totalPnlUsd.sub(baseline);
  };
}

/** Returns realized PnL since UTC midnight, resetting the baseline at day boundary. */
export function createDailyRealizedPnlTracker(initialRealizedPnlUsd: Decimal) {
  return createDailyPnlTracker(initialRealizedPnlUsd);
}

/** Returns mark-to-market net PnL (realized + unrealized - fees) since UTC midnight. */
export function createDailyNetPnlTracker(initialNetPnlUsd: Decimal) {
  return createDailyPnlTracker(initialNetPnlUsd);
}
