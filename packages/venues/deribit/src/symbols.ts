import { dec, type Decimal, type OptionType, type Underlying } from '@optarb/core';

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

export interface ParsedSymbol {
  underlying: Underlying;
  kind: 'option' | 'future' | 'perpetual';
  /** Deribit expiry is 08:00 UTC */
  expiryMs: number | null;
  strike: Decimal | null;
  optionType: OptionType | null;
}

const EXPIRY_RE = /^(\d{1,2})([A-Z]{3})(\d{2})$/;

/** Parses `BTC-PERPETUAL`, `BTC-28JUN24`, `BTC-28JUN24-70000-C`. */
export function parseInstrumentName(name: string): ParsedSymbol {
  const parts = name.split('-');
  const currency = parts[0];
  if (currency !== 'BTC' && currency !== 'ETH') {
    throw new Error(`unsupported underlying in instrument name: ${name}`);
  }
  const second = parts[1];
  if (second === undefined) throw new Error(`invalid instrument name: ${name}`);
  if (second === 'PERPETUAL') {
    return {
      underlying: currency,
      kind: 'perpetual',
      expiryMs: null,
      strike: null,
      optionType: null,
    };
  }
  const m = EXPIRY_RE.exec(second);
  if (!m) throw new Error(`invalid expiry in instrument name: ${name}`);
  const month = MONTHS[m[2]!];
  if (month === undefined) throw new Error(`invalid month in instrument name: ${name}`);
  const expiryMs = Date.UTC(2000 + Number(m[3]!), month, Number(m[1]!), 8, 0, 0);

  const strikeStr = parts[2];
  if (strikeStr === undefined) {
    return { underlying: currency, kind: 'future', expiryMs, strike: null, optionType: null };
  }
  const type = parts[3];
  if (type !== 'C' && type !== 'P') {
    throw new Error(`invalid option type in instrument name: ${name}`);
  }
  return {
    underlying: currency,
    kind: 'option',
    expiryMs,
    strike: dec(strikeStr),
    optionType: type === 'C' ? 'call' : 'put',
  };
}
