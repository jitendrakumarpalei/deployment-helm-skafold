import { serve } from '@hono/node-server';
import app from './server.js';

console.log('=== ALL ENVIRONMENT VARIABLES ===');
console.log(JSON.stringify(process.env, null, 2));
console.log('=== END ENV ===');

const port = Number(process.env.PORT ?? 8080);

try {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Control plane listening on http://0.0.0.0:${port}`);
} catch (error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Failed to start control plane server', err);
  process.exit(1);
}
