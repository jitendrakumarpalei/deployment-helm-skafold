import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { Client } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';

type AppModule = typeof import('../../apps/event-collector/src/server');

let pgContainer: PostgreSqlContainer | undefined;
let redisContainer: RedisContainer | undefined;
let connectionString: string;
let redisUrl: string;
let appModule: AppModule;

async function resetDatabase(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

async function resetRedis(url: string) {
  const client = new Redis(url);
  await client.flushall();
  await client.quit();
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

  if (process.env.TEST_REDIS_URL) {
    redisUrl = process.env.TEST_REDIS_URL;
  } else {
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  }

  await resetDatabase(connectionString);
  await resetRedis(redisUrl);

  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = redisUrl;

  await runMigrations({ databaseUrl: connectionString });

  appModule = await import('../../apps/event-collector/src/server');
}, 180_000);

afterAll(async () => {
  if (appModule?.dbPool) {
    await appModule.dbPool.end();
  }
  if (appModule?.redisClient) {
    await appModule.redisClient.quit();
  }
  if (redisContainer) {
    await redisContainer.stop();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describe('Event Collector API', () => {
  it('persists ledger events', async () => {
    const response = await appModule.default.request('/events', {
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

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.action_type).toBe('chat_completion');
  }, 30_000);
});
