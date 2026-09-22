import { describe, expect, it } from 'vitest';
import { VirtualClock, noopLogger } from '@optarb/core';
import { AutoKillSwitch, type AutoKillSwitchConfig } from './auto-kill-switch.js';

const CONFIG: AutoKillSwitchConfig = {
  heartbeatIdleMs: 60_000,
  sequenceGapThreshold: 3,
  sequenceGapWindowMs: 60_000,
  rejectThreshold: 5,
  rejectWindowMs: 60_000,
};

function makeSwitch(config: AutoKillSwitchConfig = CONFIG) {
  const clock = new VirtualClock();
  clock.set(1_000_000);
  return { clock, ks: new AutoKillSwitch(config, clock, noopLogger) };
}

describe('AutoKillSwitch', () => {
  it('starts inactive', () => {
    const { ks } = makeSwitch();
    expect(ks.isActive()).toBe(false);
    expect(ks.evaluate().active).toBe(false);
  });

  it('trips on heartbeat loss (no message for heartbeatIdleMs)', () => {
    const { clock, ks } = makeSwitch();
    ks.recordMessage('deribit', clock.nowMs());
    clock.advance(59_999);
    expect(ks.evaluate().active).toBe(false);
    clock.advance(1);
    const evalResult = ks.evaluate();
    expect(evalResult.active).toBe(true);
    expect(evalResult.reasons.some((r) => r.includes('heartbeat loss'))).toBe(true);
  });

  it('does not trip while messages keep flowing', () => {
    const { clock, ks } = makeSwitch();
    for (let i = 0; i < 10; i++) {
      ks.recordMessage('deribit', clock.nowMs());
      clock.advance(10_000);
      expect(ks.evaluate().active).toBe(false);
    }
  });

  it('trips on a sequence-gap burst inside the window', () => {
    const { clock, ks } = makeSwitch();
    ks.recordSequenceGap('bybit', clock.nowMs());
    ks.recordSequenceGap('bybit', clock.nowMs() + 1_000);
    expect(ks.isActive()).toBe(false);
    ks.recordSequenceGap('bybit', clock.nowMs() + 2_000);
    expect(ks.isActive()).toBe(true);
    expect(ks.evaluate().reasons.some((r) => r.includes('sequence-gap'))).toBe(true);
  });

  it('ignores stale sequence gaps outside the window', () => {
    const { clock, ks } = makeSwitch();
    ks.recordSequenceGap('bybit', clock.nowMs());
    ks.recordSequenceGap('bybit', clock.nowMs() + 1_000);
    clock.advance(120_000);
    ks.recordSequenceGap('bybit', clock.nowMs());
    expect(ks.isActive()).toBe(false);
  });

  it('trips on an exchange reject spike inside the window', () => {
    const { clock, ks } = makeSwitch();
    for (let i = 0; i < 4; i++) {
      ks.recordReject('deribit', clock.nowMs() + i * 1_000);
      expect(ks.isActive()).toBe(false);
    }
    ks.recordReject('deribit', clock.nowMs() + 4_000);
    expect(ks.isActive()).toBe(true);
    expect(ks.evaluate().reasons.some((r) => r.includes('reject spike'))).toBe(true);
  });

  it('latches: stays active after the tripwire condition clears', () => {
    const { clock, ks } = makeSwitch();
    ks.recordMessage('deribit', clock.nowMs());
    clock.advance(120_000);
    expect(ks.evaluate().active).toBe(true);
    // Fresh message arrives, but the latch must hold until operator reset.
    ks.recordMessage('deribit', clock.nowMs());
    expect(ks.evaluate().active).toBe(true);
  });

  it('reset clears the latch (operator action)', () => {
    const { clock, ks } = makeSwitch();
    ks.recordMessage('deribit', clock.nowMs());
    clock.advance(120_000);
    expect(ks.evaluate().active).toBe(true);
    ks.reset();
    expect(ks.isActive()).toBe(false);
    // The stale message timestamp is still there, so without a fresh message
    // the next evaluation trips again — the operator must fix the feed first.
    expect(ks.evaluate().active).toBe(true);
    ks.reset();
    ks.recordMessage('deribit', clock.nowMs());
    expect(ks.evaluate().active).toBe(false);
  });

  it('tracks venues independently', () => {
    const { clock, ks } = makeSwitch();
    ks.recordMessage('deribit', clock.nowMs());
    ks.recordMessage('bybit', clock.nowMs());
    // Only deribit goes silent.
    clock.advance(30_000);
    ks.recordMessage('bybit', clock.nowMs());
    clock.advance(31_000);
    const evalResult = ks.evaluate();
    expect(evalResult.active).toBe(true);
    expect(evalResult.reasons.some((r) => r.includes('deribit'))).toBe(true);
  });
});
