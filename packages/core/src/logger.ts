/**
 * Minimal logger interface so packages stay free of concrete logging deps.
 * Apps adapt pino to this interface. Secrets must never be logged (ADR-0006).
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * pino `redact` paths applied by every app entrypoint (ADR-0006).
 * Any log field matching these key names is replaced with `[Redacted]`
 * before it reaches the output, so API secrets can never leak via logs
 * even if a future contributor logs a whole request object.
 */
export const LOG_REDACT_PATHS: string[] = [
  '*.secret',
  '*.clientSecret',
  '*.client_secret',
  '*.apiSecret',
  '*.api_secret',
  '*.apiKey',
  '*.api_key',
  '*.privateKey',
  '*.private_key',
  '*.passphrase',
  '*.signature',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  'secret',
  'clientSecret',
  'apiSecret',
  'apiKey',
  'privateKey',
  'passphrase',
  'signature',
  'accessToken',
  'DERIBIT_API_SECRET',
  'BYBIT_API_SECRET',
  'OKX_API_SECRET',
  'OKX_PASSPHRASE',
  'BINANCE_API_SECRET',
  'POLYMARKET_PRIVATE_KEY',
];
