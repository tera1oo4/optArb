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

/** Bybit option symbol: BTC-25JUN27-45000-P-USDT (settle suffix optional on legacy). */
const SYMBOL_RE = /^([A-Z0-9]+)-(\d{2})([A-Z]{3})(\d{2})-([0-9.]+)-(C|P)(?:-(USDT|USDC))?$/;

export interface ParsedBybitSymbol {
  underlying: Underlying;
  /** Expiry at 08:00 UTC of the delivery date, epoch ms */
  expiryMs: number;
  strike: Decimal;
  optionType: OptionType;
  settleSuffix: 'USDT' | 'USDC' | null;
}

export function parseBybitSymbol(symbol: string): ParsedBybitSymbol {
  const m = SYMBOL_RE.exec(symbol);
  if (!m) throw new Error(`bybit: cannot parse option symbol: ${symbol}`);
  const [, base, dd, mon, yy, strikeStr, cp, suffix] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    'C' | 'P',
    'USDT' | 'USDC' | undefined,
  ];
  if (base !== 'BTC' && base !== 'ETH') {
    throw new Error(`bybit: unsupported underlying ${base} in ${symbol}`);
  }
  const month = MONTHS[mon];
  if (month === undefined) throw new Error(`bybit: bad month ${mon} in ${symbol}`);
  // Bybit options expire 08:00 UTC on the delivery date.
  const expiryMs = Date.UTC(2000 + Number(yy), month, Number(dd), 8, 0, 0, 0);
  return {
    underlying: base,
    expiryMs,
    strike: dec(strikeStr),
    optionType: cp === 'C' ? 'call' : 'put',
    settleSuffix: suffix ?? null,
  };
}
