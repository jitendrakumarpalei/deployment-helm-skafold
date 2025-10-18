import { Hono } from 'hono';
import type { Context } from 'hono';
import { LedgerRepository, createPool, enqueueClassificationJob } from './db.js';
import type { LedgerEventInsert } from './db.js';

interface EventPayload extends LedgerEventInsert {
  prompt_content?: string;
}

const collectorRoutes = new Hono();

export const dbPool = createPool();
const ledgerRepo = new LedgerRepository(dbPool);

collectorRoutes.get('/healthz', (c) => c.json({ status: 'ok' }));

const createHandler = async (c: Context) => {
  const payload = await c.req.json<EventPayload>();

  if (!payload.run_id || !payload.user_id || !payload.outcome) {
    return c.json({ message: 'run_id, user_id and outcome are required' }, 400);
  }

  const record = await ledgerRepo.insertEvent(payload);

  await enqueueClassificationJob(dbPool, {
    logId: record.event_id,
    promptContent: payload.prompt_content ?? null,
  });

  return c.json(record, 201);
};

collectorRoutes.post('/', createHandler);
collectorRoutes.post('', createHandler);

const app = new Hono();
app.route('/', collectorRoutes);
app.route('/events', collectorRoutes);

export default app;
