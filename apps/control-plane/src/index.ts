import { serve } from '@hono/node-server';
import app from './server.js';
import { closePool } from './db.js';

const port = Number(process.env.PORT ?? 8080);

const server = serve({
  fetch: app.fetch,
  port,
});

console.log(`Control plane listening on http://0.0.0.0:${port}`);

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await closePool();
  server.close();
  process.exit(0);
});
