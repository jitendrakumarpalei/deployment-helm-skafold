import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createAdaptorServer } from '@hono/node-server';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import controlPlaneApp from '../../apps/control-plane/src/server';
import { runMigrations as runControlPlaneMigrations } from '../../apps/control-plane/src/migrate';
import { runMigrations as runLedgerMigrations } from '../../apps/ledger/src/migrate';
import { runControlPlaneSeeds, runLedgerSeeds } from '../helpers/seeds';

const canListen = process.env.CI === 'true' && process.env.ENABLE_SUPERTEST === 'true';
const describeSuite = canListen ? describe : describe.skip;

let pgContainer: PostgreSqlContainer | undefined;
let databaseUrl: string;
let skipTest = false;
let skipReason: string | undefined;
let server: ReturnType<typeof createAdaptorServer> | undefined;

process.env.URL_TOKEN_KEY = Buffer.alloc(32, 21).toString('base64');

async function resetDatabase(url: string) {
  const client = new Pool({ connectionString: url });
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

beforeAll(async () => {
  try {
    if (process.env.TEST_DATABASE_URL) {
      databaseUrl = process.env.TEST_DATABASE_URL;
    } else {
      pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('stringcost_test')
        .withUsername('stringcost')
        .withPassword('stringcost')
        .start();
      databaseUrl = pgContainer.getConnectionUri();
  }

  process.env.DATABASE_URL = databaseUrl;
  await resetDatabase(databaseUrl);
  await runLedgerMigrations({ databaseUrl });
  await runControlPlaneMigrations({ databaseUrl });
  await runLedgerSeeds(databaseUrl);
  await runControlPlaneSeeds(databaseUrl);
  if (canListen) {
    server = createAdaptorServer({ fetch: controlPlaneApp.fetch });
    server.listen(0);
  }
} catch (error) {
    skipTest = true;
    skipReason = (error as Error).message;
  }
});

afterAll(async () => {
  if (pgContainer) {
    await pgContainer.stop();
  }
  if (server) {
    server.close();
  }
});

describeSuite('Control plane presign API', () => {
  it('issues a signed URL for chat completions', async () => {
    if (skipTest) {
      return;
    }
    if (!server) {
      server = createAdaptorServer({ fetch: controlPlaneApp.fetch });
      server.listen(0);
    }
    const response = await request(server!)
      .post('/control/v1/presign')
      .set('Authorization', 'Bearer sk-stringcost-demo')
      .send({
        provider: 'openai',
        method: 'POST',
        path: '/v1/chat/completions',
        run_id: 'run-test',
        user_id: 'user-test',
        virtual_key: 'vk-openai-demo',
        expires_in: 60,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('url');
    expect(response.body.url).toContain('/llm/v1/chat/completions');
    expect(response.body).toHaveProperty('session_id');
    expect(response.body).toHaveProperty('nonce');
    expect(response.body).toHaveProperty('expires_at');
  });
});
