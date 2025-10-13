import { serve } from '@hono/node-server';
import app, { dbPool } from './server.js';

const port = Number(process.env.PORT ?? 8080);

process.on('SIGTERM', async () => {
  await dbPool.end();
  process.exit(0);
});

serve({
  fetch: app.fetch,
  port,
});

console.log(`Event collector listening on http://0.0.0.0:${port}`);
