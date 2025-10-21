import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createAdaptorServer } from '@hono/node-server';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Disable rate limiting for tests
process.env.DISABLE_RATE_LIMITING = 'true';

// Set URL_TOKEN_KEY before import to ensure consistent key usage
if (!process.env.URL_TOKEN_KEY) {
  process.env.URL_TOKEN_KEY = Buffer.alloc(32, 31).toString('base64');
}

import { createSignedUrl } from '@stringcost/shared/signedUrl';
import { runMigrations as runControlPlaneMigrations } from '../../apps/control-plane/src/migrate';

// Dynamically import to ensure env vars are set first
const gatewayAppPromise = import('../../apps/gateway/src/app');
let gatewayApp: any;

const canListen = process.env.CI === 'true' && process.env.ENABLE_SUPERTEST === 'true';
const describeSuite = canListen ? describe : describe.skip;

let pgContainer: PostgreSqlContainer | undefined;
let databaseUrl: string;
let server: ReturnType<typeof createAdaptorServer> | undefined;
let serverHost: string | undefined;

async function resetDatabase(url: string) {
  const client = new Pool({ connectionString: url });
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

beforeAll(async () => {
  const module = await gatewayAppPromise;
  gatewayApp = module.default;

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
  process.env.SIGNED_URL_DATABASE_URL = databaseUrl;
  await resetDatabase(databaseUrl);
  await runControlPlaneMigrations({ databaseUrl }); // For the signed_url_replays table

  if (canListen) {
    server = createAdaptorServer({ fetch: gatewayApp.fetch });
    server.listen(0);
    const address = server.address();
    if (address && typeof address === 'object') {
      serverHost = `127.0.0.1:${address.port}`;
    } else if (address) {
      serverHost = String(address);
    }
    process.env.GATEWAY_BASE_URL = `http://${serverHost}`;
  }
}, 180000);

afterAll(async () => {
  if (server) {
    server.close();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describeSuite('Gateway signed URL handling', () => {
  it('returns ok for /healthz', async () => {
    const response = await request(server!).get('/healthz');
    expect(response.status).toBe(200);
  });

  it('returns ready for /readyz when db is connected', async () => {
    const response = await request(server!).get('/readyz');
    expect(response.status).toBe(200);
  });

  it('forwards request when token is valid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    );

    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost!,
      path: '/v1/chat/completions',
      clientId: 'client-1',
      provider: 'openai',
      routeConfig: { api_key: 'sk-real' },
    });

    const response = await request(server!)
      .post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
      .send({ model: 'gpt-4o-mini' });

    expect(response.status).toBe(200);
  });

  it('rejects a replayed nonce', async () => {
    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost!,
      path: '/v1/chat/completions',
      clientId: 'client-replay',
      provider: 'openai',
      routeConfig: { api_key: 'sk-real' },
    });

    const agent = request.agent(server!);
    const req = agent.post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
      .send({ model: 'gpt-4o-mini' });

    const res1 = await req;
    expect(res1.status).toBe(200);

    const res2 = await req;
    expect(res2.status).toBe(409);
    expect(res2.body.message).toContain('replay');
  });

  it.skip('rejects requests that exceed the rate limit', async () => {
    // Skipped because DISABLE_RATE_LIMITING is set in CI
    // Temporarily lower the rate limit for this test
    vi.mock('hono-rate-limiter', async (importOriginal) => {
      const original = await importOriginal<typeof import('hono-rate-limiter')>();
      return {
        ...original,
        rateLimiter: (options: any) => original.rateLimiter({ ...options, max: 5 }),
      };
    });

    const agent = request.agent(server!);
    for (let i = 0; i < 5; i++) {
      const signed = createSignedUrl({
        method: 'POST',
        host: serverHost!,
        path: '/v1/chat/completions',
        clientId: 'client-ratelimit-test',
        provider: 'openai',
        routeConfig: { api_key: 'sk-real' },
      });
      const res = await agent.post('/llm/v1/chat/completions')
        .query(Object.fromEntries(signed.params.entries()))
        .send({ model: 'gpt-4o-mini' });
      expect(res.status).toBe(200);
    }

    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost!,
      path: '/v1/chat/completions',
      clientId: 'client-ratelimit-test',
      provider: 'openai',
      routeConfig: { api_key: 'sk-real' },
    });
    const finalResponse = await agent.post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
      .send({ model: 'gpt-4o-mini' });

    expect(finalResponse.status).toBe(429);
    vi.unmock('hono-rate-limiter');
  }, { timeout: 20000 });

  it('returns a timeout error if portkey is too slow', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 31000)); // Exceed 30s timeout
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });

    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost!,
      path: '/v1/chat/completions',
      clientId: 'client-timeout-test',
      provider: 'openai',
      routeConfig: { api_key: 'sk-real' },
    });

    const response = await request(server!)
      .post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
      .send({ model: 'gpt-4o-mini' });

    expect(response.status).toBe(500);
    expect(response.body.message).toContain('timed out');
  }, 40000);
});