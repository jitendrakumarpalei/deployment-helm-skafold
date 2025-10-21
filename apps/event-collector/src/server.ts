import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { LedgerRepository, createPool, enqueueClassificationJob } from './db.js';
import type { LedgerEventInsert } from './db.js';
import { rateLimiter } from 'hono-rate-limiter';
import { PostgresStore } from '@acpr/rate-limit-postgresql';

const eventSchema = z.object({
  run_id: z.string().uuid(),
  user_id: z.string().uuid(),
  outcome: z.string(),
  step_name: z.string().max(255).optional(),
  action_type: z.string().max(255).optional(),
  duration_ms: z.number().int().optional(),
  cost_cogs_micros: z.number().int().optional(),
  revenue_billed_micros: z.number().int().optional(),
  prompt_content: z.string().optional(),
});

const collectorRoutes = new Hono();

export let dbPool = createPool();
let ledgerRepo = new LedgerRepository(dbPool);

export async function reinitializePool(connectionString: string): Promise<void> {
  await dbPool.end();
  dbPool = createPool(connectionString);
  ledgerRepo = new LedgerRepository(dbPool);
}

export async function closePool(): Promise<void> {
  await dbPool.end();
}

const limiter = (process.env.DATABASE_URL && process.env.DISABLE_RATE_LIMITING !== 'true') ? rateLimiter({
  store: new PostgresStore({
    connectionString: process.env.DATABASE_URL,
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 500, // 500 requests per minute
  keyGenerator: (c) => c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
}) : undefined;

if (limiter) {
  collectorRoutes.use('*', limiter);
}

collectorRoutes.get('/healthz', (c) => c.json({ status: 'ok' }));
collectorRoutes.get('/readyz', async (c) => {
  try {
    await dbPool.query('SELECT 1');
    return c.json({ status: 'ready' });
  } catch (error) {
    console.error('Readiness check failed:', error);
    return c.json({ status: 'not ready' }, 503);
  }
});

const createHandler = async (c: Context) => {
  const payload = c.req.valid('json');

  const record = await ledgerRepo.insertEvent(payload);

  await enqueueClassificationJob(dbPool, {
    logId: record.event_id,
    promptContent: payload.prompt_content ?? null,
  });

  return c.json(record, 201);
};

collectorRoutes.post('/', zValidator('json', eventSchema), createHandler);
collectorRoutes.post('', zValidator('json', eventSchema), createHandler);

import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors({
  origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','),
}));

app.route('/', collectorRoutes);
app.route('/events', collectorRoutes);

export default app;
