import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runPgMigrate } from 'node-pg-migrate';

export interface MigrationOptions {
  databaseUrl?: string;
  direction?: 'up' | 'down';
  count?: number;
  dryRun?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, '..', 'migrations');

export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  const {
    databaseUrl = process.env.DATABASE_URL,
    direction = 'up',
    count,
    dryRun = false
  } = options;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be provided to run migrations');
  }

  await runPgMigrate({
    databaseUrl,
    dir: migrationsDir,
    direction,
    migrationsTable: 'schema_migrations',
    count,
    dryRun,
    verbose: true,
    logger: {
      info: () => undefined,
      warn: console.warn,
      error: console.error
    }
  });
}
