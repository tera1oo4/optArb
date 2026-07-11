import { dec, type Decimal, type OptionType, type Underlying } from '@optarb/core';

/** Binance option symbol: BTC-260712-63500-C */
const SYMBOL_RE = /^([A-Z]+)-(\d{6})-([0-9.]+)-(C|P)$/;

export interface ParsedBinanceSymbol {
  underlying: Underlying;
  /** Expiry at 08:00 UTC of the delivery date, epoch ms */
  expiryMs: number;
  strike: Decimal;
  optionType: OptionType;
}

export function parseBinanceSymbol(symbol: string): ParsedBinanceSymbol {
  const m = SYMBOL_RE.exec(symbol);
  if (!m) throw new Error(`binance: cannot parse option symbol: ${symbol}`);
  const [, base, dateStr, strikeStr, cp] = m as unknown as [
    string,
    Underlying,
    string,
    string,
    'C' | 'P',
  ];
  if (base !== 'BTC' && base !== 'ETH') {
    throw new Error(`binance: unsupported underlying ${base} in ${symbol}`);
  }
  const yy = Number(dateStr.slice(0, 2));
  const mm = Number(dateStr.slice(2, 4));
  const dd = Number(dateStr.slice(4, 6));
  // Binance options expire 08:00 UTC on the delivery date.
  const expiryMs = Date.UTC(2000 + yy, mm - 1, dd, 8, 0, 0, 0);
  return {
    underlying: base,
    expiryMs,
    strike: dec(strikeStr),
    optionType: cp === 'C' ? 'call' : 'put',
  };
}

/** Stream names use lowercase symbols (BTC-... → btc-...). */
export function toStreamSymbol(symbol: string): string {
  return symbol.toLowerCase();
}
