import { serve } from '@hono/node-server';
import app from './server.js';

const port = Number(process.env.PORT ?? 8080);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Control plane listening on http://0.0.0.0:${port}`);
