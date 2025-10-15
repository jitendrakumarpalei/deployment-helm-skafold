import { serve } from '@hono/node-server';
import app from './app';

const port = Number(process.env.PORT ?? 8787);

try {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`StringCost gateway listening on http://localhost:${port}/llm`);
} catch (error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Failed to start gateway server', err);
  process.exit(1);
}
