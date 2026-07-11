import { z } from 'zod';

const EnvSchema = z.object({
  DERIBIT_WS_URL: z.string().url().default('wss://test.deribit.com/ws/api/v2'),
  DERIBIT_REST_URL: z.string().url().default('https://test.deribit.com/api/v2'),
  DERIBIT_CURRENCY: z.enum(['BTC', 'ETH']).default('BTC'),
  DERIBIT_MAX_INSTRUMENTS: z.coerce.number().int().positive().default(40),
  DERIBIT_BOOK_DEPTH: z.coerce.number().int().positive().default(10),
  CAPTURE_DIR: z.string().default('./data/capture'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  STATS_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
});

export type CollectorConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  return EnvSchema.parse(env);
}
