import { dec, type Decimal, type OptionType, type Underlying } from '@optarb/core';

/** OKX option instId: BTC-USD-260712-56000-C */
const SYMBOL_RE = /^([A-Z]+)-USD-(\d{6})-([0-9.]+)-(C|P)$/;

export interface ParsedOkxSymbol {
  underlying: Underlying;
  /** Expiry at 08:00 UTC of the delivery date, epoch ms */
  expiryMs: number;
  strike: Decimal;
  optionType: OptionType;
}

export function parseOkxSymbol(instId: string): ParsedOkxSymbol {
  const m = SYMBOL_RE.exec(instId);
  if (!m) throw new Error(`okx: cannot parse option instId: ${instId}`);
  const [, base, dateStr, strikeStr, cp] = m as unknown as [
    string,
    Underlying,
    string,
    string,
    'C' | 'P',
  ];
  if (base !== 'BTC' && base !== 'ETH') {
    throw new Error(`okx: unsupported underlying ${base} in ${instId}`);
  }
  const yy = Number(dateStr.slice(0, 2));
  const mm = Number(dateStr.slice(2, 4));
  const dd = Number(dateStr.slice(4, 6));
  // OKX options expire 08:00 UTC on the delivery date.
  const expiryMs = Date.UTC(2000 + yy, mm - 1, dd, 8, 0, 0, 0);
  return {
    underlying: base,
    expiryMs,
    strike: dec(strikeStr),
    optionType: cp === 'C' ? 'call' : 'put',
  };
}
