import { z } from 'zod';

export const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ANALYTICS_POSTGRES_URL: z.string().optional(),
});

export type AnalyticsCliConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsCliConfig {
  return EnvSchema.parse(env);
}
