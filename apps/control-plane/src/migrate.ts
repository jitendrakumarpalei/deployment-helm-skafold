import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runMigrate } from 'node-pg-migrate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, '..', 'migrations');

export async function runMigrations(options: { databaseUrl?: string; direction?: 'up' | 'down'; count?: number } = {}): Promise<void> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set to run control-plane migrations');
  }

  await runMigrate({
    databaseUrl,
    dir: migrationsDir,
    direction: options.direction ?? 'up',
    count: options.count,
    migrationsTable: 'control_plane_schema_migrations',
    logger: {
      info: () => undefined,
      warn: console.warn,
      error: console.error,
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().catch((err) => {
    console.error('Control plane migration failed', err);
    process.exit(1);
  });
}
