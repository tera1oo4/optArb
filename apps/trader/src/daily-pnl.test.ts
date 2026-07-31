import { describe, expect, it } from 'vitest';
import { dec } from '@optarb/core';
import { createDailyRealizedPnlTracker } from './daily-pnl.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('createDailyRealizedPnlTracker', () => {
  it('reports PnL relative to the initial baseline on the same day', () => {
    const baseMs = Date.now();
    const t = createDailyRealizedPnlTracker(dec('1000'));
    expect(t(baseMs, dec('1200')).toString()).toBe('200');
  });

  it('resets the baseline after UTC midnight so the loss limit applies per trading day', () => {
    const baseMs = Date.now();
    const t = createDailyRealizedPnlTracker(dec('1000'));
    expect(t(baseMs, dec('1500')).toString()).toBe('500');

    // One day later the same absolute PnL is zero for the new trading day.
    const nextDayMs = baseMs + DAY_MS;
    expect(t(nextDayMs, dec('1500')).toString()).toBe('0');
    expect(t(nextDayMs + 60 * 60 * 1000, dec('1700')).toString()).toBe('200');
  });
});
