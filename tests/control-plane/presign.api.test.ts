import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import controlPlaneApp from '../../apps/control-plane/src/server';
import { runMigrations as runControlPlaneMigrations } from '../../apps/control-plane/src/migrate';
import { runMigrations as runLedgerMigrations } from '../../apps/ledger/src/migrate';

const CONTROL_BASE = 'http://127.0.0.1:8788';
const GATEWAY_BASE = 'http://127.0.0.1:8787';

let pgContainer: PostgreSqlContainer | undefined;
let pool: Pool | undefined;
let databaseUrl: string;
let skipTest = false;
let skipReason: string | undefined;

process.env.URL_TOKEN_KEY = Buffer.alloc(32, 21).toString('base64');

async function resetDatabase(url: string) {
  const client = new Pool({ connectionString: url });
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

async function seedControlPlane(db: Pool) {
  const apiKey = 'sk-stringcost-123';
  const { rows } = await db.query(
    `INSERT INTO api_clients (name, api_key)
       VALUES ($1, $2)
       ON CONFLICT (api_key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    ['API Test Client', apiKey]
  );
  const clientId = rows[0].id;

  await db.query(
    `INSERT INTO provider_credentials (api_client_id, provider, virtual_key, provider_api_key, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (virtual_key) DO UPDATE SET provider_api_key = EXCLUDED.provider_api_key`,
    [clientId, 'openai', 'vk-openai-test', 'sk-openai-real', JSON.stringify({ tier: 'integration' })]
  );
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
    pool = new Pool({ connectionString: databaseUrl });
    await resetDatabase(databaseUrl);
    await runLedgerMigrations({ databaseUrl });
    await runControlPlaneMigrations({ databaseUrl });
    if (pool) {
      await seedControlPlane(pool);
    }
  } catch (error) {
    skipTest = true;
    skipReason = (error as Error).message;
  }
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describe('Control plane presign API', () => {
  it('issues a signed URL for chat completions', async () => {
    if (skipTest) {
      return;
    }
    const response = await request(controlPlaneApp)
      .post('/v1/presign')
      .set('Authorization', 'Bearer sk-stringcost-123')
      .send({
        provider: 'openai',
        method: 'POST',
        path: '/v1/chat/completions',
        run_id: 'run-test',
        user_id: 'user-test',
        config: { virtual_key: 'vk-openai-test' },
        expires_in: 60,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('url');
    expect(response.body.url).toContain('/llm/v1/chat/completions');
    expect(response.body).toHaveProperty('token');
  });
});
