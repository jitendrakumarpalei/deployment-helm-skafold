import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Knex } from 'knex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../knex/migrations');
const seedsDir = path.resolve(__dirname, '../knex/seeds');

export function buildKnexConfig(databaseUrl: string): Knex.Config {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be provided for Knex configuration');
  }

  return {
    client: 'pg',
    connection: databaseUrl,
    migrations: {
      directory: migrationsDir,
      tableName: 'ledger_schema_migrations',
      extension: 'js',
    },
    seeds: {
      directory: seedsDir,
      extension: 'js',
    },
  } satisfies Knex.Config;
}
