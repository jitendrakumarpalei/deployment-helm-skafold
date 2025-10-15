import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { startWorker } from './worker.js';

const app = new Hono();
const port = Number(process.env.PORT ?? 8080);

let workerHandle: { stop: () => Promise<void> } | undefined;

app.get('/healthz', (c) => c.json({ status: 'ok', workerRunning: Boolean(workerHandle) }));

startWorker()
  .then((handle) => {
    workerHandle = handle;
    console.log('Classification worker started');
  })
  .catch((error) => {
    console.error('Failed to start classification worker', error);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  if (workerHandle) {
    await workerHandle.stop();
  }
  process.exit(0);
});

try {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Worker service listening on http://0.0.0.0:${port}`);
} catch (error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Failed to start worker service', err);
  process.exit(1);
}
