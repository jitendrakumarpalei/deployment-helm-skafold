import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { ChatOpenAI } from '@langchain/openai';
import { runMigrations as runLedgerMigrations } from '../../apps/ledger/src/migrate';
import { runMigrations as runControlPlaneMigrations } from '../../apps/control-plane/src/migrate';
import controlPlaneApp from '../../apps/control-plane/src/server';
import { closePool as closeControlPlanePool } from '../../apps/control-plane/src/db';
import { runWorkerOnce } from '../../apps/worker/src/worker';
import { runControlPlaneSeeds, runLedgerSeeds } from '../helpers/seeds';

const CONTROL_PLANE_BASE = 'http://control.stringcost.local';
const GATEWAY_BASE = 'http://test';

let pgContainer: PostgreSqlContainer | undefined;
let pool: Pool;
let databaseUrl: string;
let gatewayApp: typeof import('../../apps/gateway/src/app').default;
let eventCollectorApp: typeof import('../../apps/event-collector/src/server').default;
let eventDbPool: typeof import('../../apps/event-collector/src/server').dbPool;
let originalUrlTokenKey: string | undefined;

async function resetDatabase(url: string) {
  const client = new Pool({ connectionString: url });
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

beforeAll(async () => {
  process.env.DISABLE_RATE_LIMITING = 'true';
  process.env.CONTROL_PLANE_URL = CONTROL_PLANE_BASE;
  process.env.ALBUS_BASEPATH = CONTROL_PLANE_BASE;
  process.env.GATEWAY_BASE_URL = GATEWAY_BASE;
  originalUrlTokenKey = process.env.URL_TOKEN_KEY;
  process.env.URL_TOKEN_KEY = Buffer.alloc(32, 11).toString('base64');

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

  await resetDatabase(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.META_LLM_CLASSIFIER_ENDPOINT = 'http://classifier.local';
  process.env.META_LLM_API_KEY = 'dummy';
  process.env.WORKER_POLL_INTERVAL_MS = '50';

  await runLedgerMigrations({ databaseUrl });
  await runControlPlaneMigrations({ databaseUrl });

  pool = new Pool({ connectionString: databaseUrl });
  await runLedgerSeeds(databaseUrl);
  await runControlPlaneSeeds(databaseUrl);

  gatewayApp = (await import('../../apps/gateway/src/app')).default;
  const eventModule = await import('../../apps/event-collector/src/server');
  eventCollectorApp = eventModule.default;
  eventDbPool = eventModule.dbPool;

}, 180_000);

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (eventDbPool) {
    await eventDbPool.end();
  }
  await closeControlPlanePool();
  if (pgContainer) {
    await pgContainer.stop();
  }
  if (originalUrlTokenKey === undefined) {
    delete process.env.URL_TOKEN_KEY;
  } else {
    process.env.URL_TOKEN_KEY = originalUrlTokenKey;
  }
  vi.restoreAllMocks();
});

describe('LangChain → StringCost Gateway', () => {
  it('logs, classifies, and updates the ledger via control plane config', async () => {
    const runId = randomUUID();
    let capturedPrompt = '';

    const fetchProxy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (requestUrl.startsWith(`${GATEWAY_BASE}/llm`)) {
        const requestIsRequest = typeof Request !== 'undefined' && input instanceof Request;
        const method = init.method ?? (requestIsRequest ? input.method : 'GET');
        const headers = new Headers(
          init.headers ?? (requestIsRequest ? input.headers : undefined) ?? {}
        );

        let body: BodyInit | undefined = init.body;
        if (!body && requestIsRequest) {
          body = await input.clone().text();
        }

        const presignResponse = await controlPlaneApp.request('/v1/presign', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-stringcost-demo',
          },
          body: JSON.stringify({
            provider: 'openai',
            method,
            path: requestUrl.replace(`${GATEWAY_BASE}/llm`, '') || '/',
            run_id: runId,
            user_id: '12345678-1234-1234-1234-123456789def',
            metadata: { test: true },
            virtual_key: 'vk-openai-demo',
          }),
        });

        if (!presignResponse.ok) {
          throw new Error(`Presign failed: ${presignResponse.status}`);
        }

        const presignBody = await presignResponse.json<Record<string, string>>();
        const signedUrl = presignBody.url;

        return gatewayApp.request(signedUrl, {
          method,
          headers,
          body,
        });
      }

      if (requestUrl.includes('/v1/chat/completions')) {
        const rawBody =
          typeof init.body === 'string'
            ? init.body
            : init.body
              ? await new Response(init.body).text()
              : typeof Request !== 'undefined' && input instanceof Request
                ? await input.clone().text()
                : '{}';
        const body = JSON.parse(rawBody || '{}');
        capturedPrompt = body?.messages?.[body.messages.length - 1]?.content ?? '';

        await eventCollectorApp.request('/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            run_id: runId,
            user_id: '12345678-1234-1234-1234-123456789def',
            outcome: 'success',
            action_type: 'chat_completion',
            prompt_content: capturedPrompt,
          }),
        });

        await runWorkerOnce(pool);

        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Response from upstream' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (requestUrl === 'http://classifier.local') {
        return new Response(
          JSON.stringify({ action_type: 'synthesis' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call to ${requestUrl}`);
    });

    vi.spyOn(global, 'fetch' as any).mockImplementation(fetchProxy);

    const llm = new ChatOpenAI({
      apiKey: 'unused',
      model: 'gpt-4o-mini',
      configuration: {
        baseURL: `${GATEWAY_BASE}/llm/v1`,
        fetch: fetchProxy as any,
      },
      clientOptions: {
        fetch: fetchProxy as any,
        defaultHeaders: {
          Authorization: 'Bearer sk-openai-demo',
        },
      },
    });

    const result = await llm.invoke('What are the seven wonders of the world?');
    expect(result.content).toContain('Response from upstream');
    expect(capturedPrompt).toContain('seven wonders');

    let actionType = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      const { rows } = await pool.query(
        'SELECT action_type FROM ledger_events WHERE run_id = $1',
        [runId]
      );
      if (rows[0]?.action_type === 'synthesis') {
        actionType = rows[0].action_type;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(actionType).toBe('synthesis');
    expect(fetchProxy).toHaveBeenCalled();

    const remainingJobs = await pool.query('SELECT COUNT(*)::int AS count FROM classification_jobs');
    expect(remainingJobs.rows[0].count).toBe(0);
  }, 90_000);
});
