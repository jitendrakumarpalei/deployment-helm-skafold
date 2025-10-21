import { serve } from '@hono/node-server';
import app from './app';
import { closeReplayStorePool } from './replayStore';

const port = Number(process.env.PORT ?? 8787);

const server = serve({
  fetch: app.fetch,
  port,
});

console.log(`StringCost gateway listening on http://localhost:${port}/llm`);

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await closeReplayStorePool();
  server.close();
  process.exit(0);
});
