import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { ChatOpenAI } from '@langchain/openai';
import { randomUUID } from 'crypto';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { startWorker } from '../../apps/worker/src/worker';

let pgContainer: PostgreSqlContainer | undefined;
let redisContainer: RedisContainer | undefined;
let pool: Pool;
let redisUrl: string;
let databaseUrl: string;
let workerHandle: { stop: () => Promise<void> } | undefined;
let gatewayApp: typeof import('../../apps/gateway/src/app').default;
let eventCollectorApp: typeof import('../../apps/event-collector/src/server').default;
let eventDbPool: typeof import('../../apps/event-collector/src/server').dbPool;
let eventRedis: typeof import('../../apps/event-collector/src/server').redisClient;

async function resetDatabase(url: string) {
  const resetPool = new Pool({ connectionString: url });
  await resetPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await resetPool.end();
}

async function resetRedis(url: string) {
  const client = new Redis(url);
  await client.flushall();
  await client.quit();
}

beforeAll(async () => {
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

  if (process.env.TEST_REDIS_URL) {
    redisUrl = process.env.TEST_REDIS_URL;
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  }

  await resetDatabase(databaseUrl);
  await resetRedis(redisUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.META_LLM_CLASSIFIER_ENDPOINT = 'http://classifier.local';
  process.env.META_LLM_API_KEY = 'dummy';
  process.env.WORKER_POLL_INTERVAL_MS = '50';

  await runMigrations({ databaseUrl });

  gatewayApp = (await import('../../apps/gateway/src/app')).default;
  const eventModule = await import('../../apps/event-collector/src/server');
  eventCollectorApp = eventModule.default;
  eventDbPool = eventModule.dbPool;
  eventRedis = eventModule.redisClient;

  pool = new Pool({ connectionString: databaseUrl });

  workerHandle = await startWorker();
}, 180_000);

afterAll(async () => {
  await workerHandle?.stop();
  await pool.end();
  if (eventRedis) {
    await eventRedis.quit();
  }
  await eventDbPool.end();
  if (redisContainer) {
    await redisContainer.stop();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
  vi.restoreAllMocks();
});

describe('LangChain → StringCost Gateway', () => {
  it('logs, classifies, and updates the ledger', async () => {
    const runId = randomUUID();
    let capturedPrompt = '';

    const fetchProxy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.startsWith('http://stringcost.local/llm')) {
        const target = url.replace('http://stringcost.local', 'http://test');
        const response = await gatewayApp.request(target, init);
        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Gateway error ${response.status}: ${errorBody}`);
        }
        return response;
      }

      if (url.includes('/v1/chat/completions')) {
        const body = JSON.parse((init?.body as string) ?? '{}');
        capturedPrompt = body?.messages?.[body.messages.length - 1]?.content ?? '';

        await eventCollectorApp.request('/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            run_id: runId,
            user_id: 'user-langchain',
            outcome: 'success',
            action_type: 'chat_completion',
            prompt_content: capturedPrompt,
          }),
        });

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
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }

      if (url === 'http://classifier.local') {
        return new Response(
          JSON.stringify({ action_type: 'synthesis' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    });

    vi.spyOn(global, 'fetch' as any).mockImplementation(fetchProxy);

    const llm = new ChatOpenAI({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      configuration: {
        baseURL: 'http://stringcost.local/llm/v1',
        fetch: fetchProxy as any,
      },
      clientOptions: {
        fetch: fetchProxy as any,
        defaultHeaders: {
          Authorization: 'Bearer stringcost-key',
          'x-stringcost-provider': 'openai',
          'x-stringcost-config': JSON.stringify({ provider: 'openai' }),
          'x-stringcost-run-id': runId,
          'x-stringcost-user-id': 'user-langchain',
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
  }, 90_000);
});
