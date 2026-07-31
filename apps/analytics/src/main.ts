import 'dotenv/config';
import {
  AnalyticsEngine,
  formatReport,
  PostgresTradeLog,
  reportToCsv,
  reportToJson,
} from '@optarb/analytics';
import { loadConfig } from './config.js';

interface CliArgs {
  from?: Date;
  to?: Date;
  output: 'json' | 'csv' | 'table';
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { output: 'table' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--from':
        out.from = new Date(argv[++i] ?? '');
        break;
      case '--to':
        out.to = new Date(argv[++i] ?? '');
        break;
      case '--output':
        out.output = (argv[++i] ?? 'table') as CliArgs['output'];
        break;
    }
  }
  if (!['json', 'csv', 'table'].includes(out.output)) {
    throw new Error(`unsupported output format: ${out.output}`);
  }
  if (out.from && Number.isNaN(out.from.getTime())) {
    throw new Error('invalid --from date');
  }
  if (out.to && Number.isNaN(out.to.getTime())) {
    throw new Error('invalid --to date');
  }
  return out;
}

function usage(): never {
  console.error('usage: pnpm analytics --from 2026-07-01 --to 2026-07-08 --output json|csv|table');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const connectionString = cfg.ANALYTICS_POSTGRES_URL || process.env.PERSIST_POSTGRES_URL;
  if (!connectionString) {
    console.error('ANALYTICS_POSTGRES_URL or PERSIST_POSTGRES_URL must be set');
    process.exit(1);
  }

  const log = new PostgresTradeLog(connectionString, { from: args.from, to: args.to });
  try {
    const engine = new AnalyticsEngine(log);
    const report = await engine.computeReport({ from: args.from, to: args.to });
    if (args.output === 'json') {
      console.log(JSON.stringify(reportToJson(report), null, 2));
    } else if (args.output === 'csv') {
      console.log(reportToCsv(report));
    } else {
      console.log(formatReport(report));
    }
  } finally {
    await log.close();
  }
}

main().catch((err: unknown) => {
  console.error('analytics fatal error', err);
  process.exit(1);
});
