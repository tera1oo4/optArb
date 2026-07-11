import { describe, expect, it } from 'vitest';
import { dec, instrumentId, type Instrument } from '@optarb/core';
import { parsePolymarketQuestion } from './symbols.js';

describe('parsePolymarketQuestion', () => {
  it('parses expiry-level "above" BTC markets as digital calls', () => {
    const p = parsePolymarketQuestion('Will the price of Bitcoin be above $62,000 on July 12?');
    expect(p.underlying).toBe('BTC');
    expect(p.strike?.toString()).toBe('62000');
    expect(p.parseable).toBe(true);
  });

  it('parses ETH and decimal strikes', () => {
    const p = parsePolymarketQuestion('Will the price of Ethereum be above $1,950.50 on July 12?');
    expect(p.underlying).toBe('ETH');
    expect(p.strike?.toString()).toBe('1950.5');
    expect(p.parseable).toBe(true);
  });

  it('treats "reach"/"dip" touch markets as unparseable (different payoff)', () => {
    const reach = parsePolymarketQuestion('Will Bitcoin reach $65,000 in July?');
    expect(reach.underlying).toBe('BTC');
    expect(reach.strike).toBeNull();
    expect(reach.parseable).toBe(false);

    const dip = parsePolymarketQuestion('Will Ethereum dip to $1,200 in July?');
    expect(dip.underlying).toBe('ETH');
    expect(dip.strike).toBeNull();
    expect(dip.parseable).toBe(false);
  });

  it('up/down markets have no strike', () => {
    const p = parsePolymarketQuestion('Bitcoin Up or Down - July 11, 1:15PM-1:30PM ET');
    expect(p.underlying).toBe('BTC');
    expect(p.strike).toBeNull();
    expect(p.parseable).toBe(false);
  });

  it('returns null underlying for non-crypto questions', () => {
    const p = parsePolymarketQuestion('Will Norway win on 2026-07-11?');
    expect(p.underlying).toBeNull();
    expect(p.parseable).toBe(false);
  });

  it('matches BTC ticker with word boundaries (no false positives)', () => {
    expect(parsePolymarketQuestion('Will BTC be above $70,000 tomorrow?').underlying).toBe('BTC');
    // "eth" inside other words must not match
    expect(parsePolymarketQuestion('Will something happen above $5?').underlying).toBeNull();
  });
});

// Ensures the Instrument shape built from a parsed question fits the canonical model.
describe('binary instrument shape', () => {
  it('YES token = digital call, NO token = digital put at the same strike', () => {
    const expiryMs = Date.UTC(2026, 6, 12, 16, 0, 0, 0);
    const base = {
      venue: 'polymarket' as const,
      kind: 'binary' as const,
      underlying: 'BTC' as const,
      expiryMs,
      strike: dec('62000'),
      contractMultiplier: dec(1),
      quoteCurrency: 'USDC' as const,
      settleCurrency: 'USDC' as const,
    };
    const yes: Instrument = {
      ...base,
      id: instrumentId('polymarket', 'token-yes'),
      venueSymbol: 'token-yes',
      optionType: 'call',
      metadata: { conditionId: '0xabc', outcome: 'Yes', parseable: 'true' },
    };
    const no: Instrument = {
      ...base,
      id: instrumentId('polymarket', 'token-no'),
      venueSymbol: 'token-no',
      optionType: 'put',
      metadata: { conditionId: '0xabc', outcome: 'No', parseable: 'true' },
    };
    expect(yes.optionType).toBe('call');
    expect(no.optionType).toBe('put');
    expect(yes.metadata?.conditionId).toBe(no.metadata?.conditionId);
  });
});
