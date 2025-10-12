import { Hono } from 'hono';
import Redis from 'ioredis';
import { LedgerRepository, createPool } from './db.js';
import type { LedgerEventInsert } from './db.js';

interface EventPayload extends LedgerEventInsert {
  prompt_content?: string;
}

const app = new Hono();

export const dbPool = createPool();
export const redisClient = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : undefined;
const queueKey = process.env.CLASSIFICATION_QUEUE_KEY ?? 'classification_jobs';
const ledgerRepo = new LedgerRepository(dbPool);

app.post('/events', async (c) => {
  const payload = await c.req.json<EventPayload>();

  if (!payload.run_id || !payload.user_id || !payload.outcome) {
    return c.json({ message: 'run_id, user_id and outcome are required' }, 400);
  }

  const record = await ledgerRepo.insertEvent(payload);

  if (redisClient) {
    await redisClient.lpush(
      queueKey,
      JSON.stringify({
        logId: record.event_id,
        promptContent: payload.prompt_content ?? '',
        timestamp: new Date().toISOString(),
      })
    );
  }

  return c.json(record, 201);
});

export default app;
