import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { buildKnexConfig } from './knexConfig';

export interface MigrationOptions {
  databaseUrl?: string;
  direction?: 'up' | 'down';
}

export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be provided to run migrations');
  }

  const db = knex(buildKnexConfig(databaseUrl));
  try {
    if (options.direction === 'down') {
      await db.migrate.rollback(undefined, true);
    } else {
      await db.migrate.latest();
    }
  } finally {
    await db.destroy();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runMigrations().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
