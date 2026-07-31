import type { Decimal } from '@optarb/core';

/** Returns realized PnL since UTC midnight, resetting the baseline at day boundary. */
export function createDailyRealizedPnlTracker(initialRealizedPnlUsd: Decimal) {
  let baseline = initialRealizedPnlUsd;
  let baselineDay = new Date().getUTCDate();
  return (nowMs: number, totalRealizedPnlUsd: Decimal): Decimal => {
    const currentDay = new Date(nowMs).getUTCDate();
    if (currentDay !== baselineDay) {
      baseline = totalRealizedPnlUsd;
      baselineDay = currentDay;
    }
    return totalRealizedPnlUsd.sub(baseline);
  };
}
