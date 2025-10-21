import { serve } from '@hono/node-server';
import app, { dbPool } from './server.js';

const port = Number(process.env.PORT ?? 8080);

process.on('SIGTERM', async () => {
  await dbPool.end();
  process.exit(0);
});

try {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Event collector listening on http://0.0.0.0:${port}`);
} catch (error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Failed to start event collector server', err);
  process.exit(1);
}
