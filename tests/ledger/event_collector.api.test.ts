import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAdaptorServer } from '@hono/node-server';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { runLedgerSeeds } from '../helpers/seeds';
import eventCollectorApp from '../../apps/event-collector/src/server';

const canListen = process.env.CI === 'true' && process.env.ENABLE_SUPERTEST === 'true';
const describeSuite = canListen ? describe : describe.skip;

let pgContainer: PostgreSqlContainer | undefined;
let connectionString: string;
let server: ReturnType<typeof createAdaptorServer> | undefined;

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
  await runMigrations({ databaseUrl: connectionString });
  await runLedgerSeeds(connectionString);

  if (canListen) {
    server = createAdaptorServer({ fetch: eventCollectorApp.fetch });
    server.listen(0);
  }
}, 180_000);

afterAll(async () => {
  if (server) {
    server.close();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describeSuite('Event Collector API', () => {
  it('returns ok for /healthz', async () => {
    const response = await request(server!).get('/healthz');
    expect(response.status).toBe(200);
  });

  it('returns ready for /readyz when db is connected', async () => {
    const response = await request(server!).get('/readyz');
    expect(response.status).toBe(200);
  });

  it('persists ledger events', async () => {
    const response = await request(server!)
      .post('/events')
      .send({
        run_id: 'f2d1b08a-78da-40a0-a1a3-b47da33d5a6b',
        user_id: 'user-abc',
        outcome: 'success',
        action_type: 'chat_completion'
      });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.action_type).toBe('chat_completion');
  });

  it.each([
    { body: { user_id: 'user-abc', outcome: 'success' }, message: /run_id/i },
    { body: { run_id: 'not-a-uuid', user_id: 'user-abc', outcome: 'success' }, message: /uuid/i },
  ])('rejects invalid body ($body)', async ({ body, message }) => {
    const response = await request(server!).post('/events').send(body);
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(message);
  });

  it('rejects requests that exceed the rate limit', async () => {
    // Temporarily lower the rate limit for this test
    vi.mock('hono-rate-limiter', async (importOriginal) => {
      const original = await importOriginal<typeof import('hono-rate-limiter')>();
      return {
        ...original,
        rateLimit: (options: any) => original.rateLimit({ ...options, max: 5 }),
      };
    });

    const agent = request.agent(server!);
    const req = agent.post('/events')
      .send({
        run_id: 'a2d1b08a-78da-40a0-a1a3-b47da33d5a6c',
        user_id: 'user-def',
        outcome: 'success',
      });

    let response;
    for (let i = 0; i < 6; i++) {
      response = await req;
    }

    expect(response!.status).toBe(429);
  }, { timeout: 15000 });
});
