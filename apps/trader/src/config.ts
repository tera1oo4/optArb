import { z } from 'zod';

const VenueEnum = z.enum(['deribit', 'bybit', 'okx', 'binance', 'polymarket']);

const EnvSchema = z.object({
  VENUES: z
    .string()
    .default('deribit,bybit,okx,binance')
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(VenueEnum).min(1)),

  DERIBIT_WS_URL: z.string().url().default('wss://test.deribit.com/ws/api/v2'),
  DERIBIT_REST_URL: z.string().url().default('https://test.deribit.com/api/v2'),
  DERIBIT_CURRENCY: z.enum(['BTC', 'ETH']).default('BTC'),
  DERIBIT_MAX_INSTRUMENTS: z.coerce.number().int().positive().default(200),
  DERIBIT_BOOK_DEPTH: z.coerce.number().int().positive().default(10),

  BYBIT_WS_URL: z.string().url().default('wss://stream-testnet.bybit.com/v5/public/option'),
  BYBIT_REST_URL: z.string().url().default('https://api-testnet.bybit.com'),
  BYBIT_BASE_COIN: z.enum(['BTC', 'ETH']).default('BTC'),
  BYBIT_MAX_INSTRUMENTS: z.coerce.number().int().positive().default(200),
  BYBIT_BOOK_DEPTH: z.coerce.number().int().positive().default(25),

  OKX_WS_URL: z.string().url().default('wss://wspap.okx.com:8443/ws/v5/public'),
  OKX_REST_URL: z.string().url().default('https://www.okx.com'),
  OKX_DEMO_TRADING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OKX_ULY: z.enum(['BTC-USD', 'ETH-USD']).default('BTC-USD'),
  OKX_MAX_INSTRUMENTS: z.coerce.number().int().positive().default(200),

  BINANCE_MARKET_WS_URL: z.string().url().default('wss://fstream.binance.com/market/stream'),
  BINANCE_PUBLIC_WS_URL: z.string().url().default('wss://fstream.binance.com/public/stream'),
  BINANCE_REST_URL: z.string().url().default('https://eapi.binance.com'),
  BINANCE_UNDERLYINGS: z
    .string()
    .default('BTC')
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(z.enum(['BTC', 'ETH'])).min(1)),
  BINANCE_MAX_INSTRUMENTS: z.coerce.number().int().positive().default(200),
  BINANCE_BOOK_DEPTH: z.coerce.number().int().positive().default(10),

  // Polymarket: no testnet exists — public mainnet read-only only.
  POLYMARKET_GAMMA_URL: z.string().url().default('https://gamma-api.polymarket.com'),
  POLYMARKET_WS_URL: z
    .string()
    .url()
    .default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  POLYMARKET_UNDERLYINGS: z
    .string()
    .default('BTC')
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(z.enum(['BTC', 'ETH'])).min(1)),
  POLYMARKET_MAX_MARKETS: z.coerce.number().int().positive().default(20),
  POLYMARKET_BOOK_DEPTH: z.coerce.number().int().positive().default(10),

  /** Cross-venue detector thresholds */
  SIGNAL_MIN_SPREAD_BPS: z.coerce.number().positive().default(25),
  SIGNAL_MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(2_000),
  SIGNAL_MIN_SIZE_USD: z.coerce.number().positive().default(1_000),
  SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(250),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  STATS_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type TraderConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TraderConfig {
  return EnvSchema.parse(env);
}
