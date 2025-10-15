import { Hono } from 'hono';
import { LedgerRepository, createPool, enqueueClassificationJob } from './db.js';
import type { LedgerEventInsert } from './db.js';

interface EventPayload extends LedgerEventInsert {
  prompt_content?: string;
}

const collectorApp = new Hono();

export const dbPool = createPool();
const ledgerRepo = new LedgerRepository(dbPool);

collectorApp.get('/healthz', (c) => c.json({ status: 'ok' }));

collectorApp.post('/events', async (c) => {
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
});

function forwardToCollector(c: import('hono').Context) {
  const url = new URL(c.req.url);
  const stripped = url.pathname.replace(/^\/events/, '') || '/';
  url.pathname = stripped.startsWith('/') ? stripped : `/${stripped}`;
  const forwarded = new Request(url.toString(), c.req.raw);
  return collectorApp.fetch(forwarded);
}

const app = new Hono();
app.route('/', collectorApp);
app.all('/events', (c) => forwardToCollector(c));
app.all('/events/*', (c) => forwardToCollector(c));

export default app;
