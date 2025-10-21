import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { runLedgerSeeds } from '../helpers/seeds';

type AppModule = typeof import('../../apps/event-collector/src/server');

let pgContainer: PostgreSqlContainer | undefined;
let connectionString: string;
let appModule: AppModule;

async function resetDatabase(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    connectionString = process.env.TEST_DATABASE_URL;
  } else {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('stringcost_test')
      .withUsername('stringcost')
      .withPassword('stringcost')
      .start();
    connectionString = pgContainer.getConnectionUri();
  }

  await resetDatabase(connectionString);

  process.env.DATABASE_URL = connectionString;
  process.env.DISABLE_RATE_LIMITING = 'true';
  await runMigrations({ databaseUrl: connectionString });
  await runLedgerSeeds(connectionString);

  appModule = await import('../../apps/event-collector/src/server');
}, 180_000);

afterAll(async () => {
  if (appModule?.dbPool) {
    await appModule.dbPool.end();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describe('Event Collector API', () => {
  it('persists ledger events', async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const response = await appModule.default.request('/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        run_id: 'f2d1b08a-78da-40a0-a1a3-b47da33d5a6b',
        user_id: '12345678-1234-1234-1234-123456789abc',
        outcome: 'success',
        action_type: 'chat_completion'
      })
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.action_type).toBe('chat_completion');

    const result = await client.query('SELECT * FROM classification_jobs');
    expect(result.rows).toHaveLength(1);
    await client.end();
  }, 30_000);
});
