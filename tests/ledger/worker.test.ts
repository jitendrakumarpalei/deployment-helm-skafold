import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { ClassificationQueue } from '../../apps/worker/src/queue';
import { startWorker } from '../../apps/worker/src/worker';

let pgContainer: PostgreSqlContainer | undefined;
let redisContainer: RedisContainer | undefined;
let pool: Pool;
let redisUrl: string;
let databaseUrl: string;

async function resetDatabase(url: string) {
  const pool = new Pool({ connectionString: url });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.end();
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

  await runMigrations({ databaseUrl });

  pool = new Pool({ connectionString: databaseUrl });

  await pool.query(
    `INSERT INTO ledger_events(event_id, run_id, user_id, outcome)
     VALUES ($1, $2, $3, $4)`,
    ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'user-xyz', 'success']
  );

  const redisClient = new Redis(redisUrl);
  const queue = new ClassificationQueue(redisClient, 'classification_jobs');
  await queue.enqueue({
    logId: '11111111-1111-1111-1111-111111111111',
    promptContent: 'Classify me',
    timestamp: new Date().toISOString(),
  });
  await redisClient.quit();
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (redisContainer) {
    await redisContainer.stop();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Classification worker', () => {
  it('updates ledger events with classifier results', async () => {
    const classifierSpy = vi
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, json: async () => ({ action_type: 'synthesis' }) } as Response);

    const intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((fn) => {
      void fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    const worker = await startWorker();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const record = await pool.query(
      'SELECT action_type FROM ledger_events WHERE event_id = $1',
      ['11111111-1111-1111-1111-111111111111']
    );

    expect(record.rows[0].action_type).toBe('synthesis');
    expect(classifierSpy).toHaveBeenCalled();
    expect(intervalSpy).toHaveBeenCalled();

    await worker.stop();
  }, 30_000);
});
