import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

interface Migration {
  name: string;
  up: string;
  down: string;
}

function captureOr(match: RegExpMatchArray | null, fallback: string): string {
  return match && match[1] ? match[1].trim() : fallback;
}

function parseSections(sql: string): { up: string; down: string } {
  const upMatch = sql.match(/--\s*##\s*up\s*\n([\s\S]*?)(?=--\s*##\s*down|--\s*##\s*up|$)/i);
  const downMatch = sql.match(/--\s*##\s*down\s*\n([\s\S]*?)(?=--\s*##\s*up|--\s*##\s*down|$)/i);
  return {
    up: captureOr(upMatch, sql.trim()),
    down: captureOr(downMatch, ''),
  };
}

async function loadMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const { up, down } = parseSections(sql);
    migrations.push({ name: file, up, down });
  }
  return migrations;
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedMigrations(client: pg.PoolClient): Promise<Set<string>> {
  const result = await client.query<{ name: string }>('SELECT name FROM migrations');
  return new Set(result.rows.map((r) => r.name));
}

async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string,
  direction: 'up' | 'down',
): Promise<void> {
  const migrations = await loadMigrations(migrationsDir);
  if (migrations.length === 0) {
    console.log('No migration files found');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    if (direction === 'up') {
      const applied = await appliedMigrations(client);
      for (const migration of migrations) {
        if (applied.has(migration.name)) {
          console.log(`Skipping ${migration.name} (already applied)`);
          continue;
        }
        if (!migration.up) {
          throw new Error(`Migration ${migration.name} has no up section`);
        }
        await client.query(migration.up);
        await client.query('INSERT INTO migrations(name) VALUES ($1)', [migration.name]);
        console.log(`Applied ${migration.name}`);
      }
    } else {
      for (const migration of migrations.slice().reverse()) {
        const applied = await appliedMigrations(client);
        if (!applied.has(migration.name)) {
          console.log(`Skipping ${migration.name} (not applied)`);
          continue;
        }
        if (!migration.down) {
          throw new Error(`Migration ${migration.name} has no down section`);
        }
        await client.query(migration.down);
        await client.query('DELETE FROM migrations WHERE name = $1', [migration.name]);
        console.log(`Rolled back ${migration.name}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createMigration(migrationsDir: string, name: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const fileName = `${timestamp}_${name}.sql`;
  const content = `-- ## up\n\n-- ${name}\n\n-- ## down\n\n-- rollback ${name}\n`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(migrationsDir, fileName), content);
  console.log(`Created ${fileName}`);
}

function usage(): never {
  console.error('Usage: migrate.ts up|down|create <name>');
  process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const migrationsDir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');

  if (command === 'create') {
    const name = process.argv[3];
    if (!name) usage();
    await createMigration(migrationsDir, name);
    return;
  }

  if (command !== 'up' && command !== 'down') {
    usage();
  }

  const databaseUrl = process.env.PERSIST_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('PERSIST_POSTGRES_URL or DATABASE_URL must be set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool, migrationsDir, command);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
