import { Hono } from 'hono';
import { LedgerRepository, createPool } from './db.js';
import type { LedgerEventInsert } from './db.js';

const app = new Hono();

export const dbPool = createPool();
const ledgerRepo = new LedgerRepository(dbPool);

app.post('/events', async (c) => {
  const payload = await c.req.json<LedgerEventInsert>();

  if (!payload.run_id || !payload.user_id || !payload.outcome) {
    return c.json({ message: 'run_id, user_id and outcome are required' }, 400);
  }

  const record = await ledgerRepo.insertEvent(payload);
  return c.json(record, 201);
});

export default app;
