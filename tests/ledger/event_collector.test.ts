import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../apps/ledger/src/migrate';

let app: any;
let dbPool: any;

let container: PostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('stringcost_test')
    .withUsername('stringcost')
    .withPassword('stringcost')
    .start();

  connectionString = container.getConnectionUri();
  process.env.DATABASE_URL = connectionString;

  await runMigrations({ databaseUrl: connectionString });

  ({ default: app, dbPool } = await import('../../apps/event-collector/src/server'));
}, 180_000);

afterAll(async () => {
  if (dbPool) {
    await dbPool.end();
  }
  if (container) {
    await container.stop();
  }
});

describe('Event Collector API', () => {
  it('persists ledger events', async () => {
    const response = await app.request('/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        run_id: 'f2d1b08a-78da-40a0-a1a3-b47da33d5a6b',
        user_id: 'user-abc',
        outcome: 'success',
        action_type: 'chat_completion'
      })
    });

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.action_type).toBe('chat_completion');
  });
});
