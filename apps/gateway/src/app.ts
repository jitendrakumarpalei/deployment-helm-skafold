import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import portkeyApp from '../../../vendor/portkey-gateway/src/index';
import { adaptResponse } from './middleware/responseAdapter';
import { createForwardRequest } from './middleware/requestAdapter';
import { verifySignedRequest, type VerifiedSignedRequest } from '@stringcost/shared/signedUrl';
import { assertNonce, pool as replayStorePool } from './replayStore';
import { rateLimiter } from 'hono-rate-limiter';
import { PostgresStore } from '@acpr/rate-limit-postgresql';
import { cors } from 'hono/cors';

const app = new Hono<{ Variables: { verified: VerifiedSignedRequest } }>();

app.use('*', cors({
  origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','),
}));

app.get('/healthz', (c) => c.json({ status: 'ok' }));
app.get('/readyz', async (c) => {
  if (!replayStorePool) {
    // In-memory store is always ready
    return c.json({ status: 'ready' });
  }
  try {
    await replayStorePool.query('SELECT 1');
    return c.json({ status: 'ready' });
  } catch (error) {
    console.error('Readiness check failed:', error);
    return c.json({ status: 'not ready' }, 503);
  }
});

const verifySignedUrlMiddleware = async (c: Context, next: () => Promise<void>) => {
  const originalRequest = c.req.raw;
  const url = new URL(originalRequest.url);
  const search = url.searchParams;

  if (!search.has('kid')) {
    return c.json({ message: 'Missing signed parameters' }, 400);
  }

  const requestPath = c.req.path.startsWith('/llm') ? c.req.path.slice(4) || '/' : c.req.path;
  const expectedBodyHash = search.get('body');
  const actualBodyHash = expectedBodyHash ? await hashRequestBody(originalRequest) : undefined;

  let verified;
  try {
    verified = await verifySignedRequest(search, {
      method: originalRequest.method,
      host: url.host,
      path: requestPath,
      bodyHash: actualBodyHash,
    });
  } catch (error) {
    return c.json({ message: (error as Error).message || 'Invalid signed URL' }, 403);
  }

  try {
    await assertNonce(verified.sessionId, verified.nonce, verified.expiresAt);
  } catch (error) {
    return c.json({ message: (error as Error).message || 'Signed URL replay detected' }, 409);
  }

  c.set('verified', verified);
  await next();
};

const llmLimiter = (process.env.DATABASE_URL && process.env.DISABLE_RATE_LIMITING !== 'true') ? rateLimiter({
  store: new PostgresStore({
    connectionString: process.env.DATABASE_URL,
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
  keyGenerator: (c) => c.get('verified')?.clientId ?? 'unknown',
}) : undefined;


const handlePortkey = async (c: Context) => {
  const verified = c.get('verified');
  const originalRequest = c.req.raw;

  const forwardedHeaders = new Headers(originalRequest.headers);
  forwardedHeaders.set('x-portkey-provider', verified.provider);
  const { virtual_key, credential_metadata, ...routeConfig } = verified.routeConfig as Record<string, unknown>;
  forwardedHeaders.set('x-portkey-config', JSON.stringify(routeConfig));
  if (virtual_key) {
    forwardedHeaders.set('x-portkey-virtual-key', String(virtual_key));
  }
  if (verified.runId) {
    forwardedHeaders.set('x-stringcost-run-id', verified.runId);
  }
  if (verified.userId) {
    forwardedHeaders.set('x-stringcost-user-id', verified.userId);
  }
  if (verified.metadata) {
    forwardedHeaders.set('x-stringcost-metadata', JSON.stringify(verified.metadata));
  }
  if (verified.scope) {
    forwardedHeaders.set('x-stringcost-scope', verified.scope);
  }
  if (credential_metadata) {
    forwardedHeaders.set('x-stringcost-credential-metadata', JSON.stringify(credential_metadata));
  }

  const stripParams = [
    'kid',
    'client',
    'provider',
    'method',
    'host',
    'path',
    'exp',
    'nonce',
    'session',
    'cfg',
    'cfg_h',
    'sig',
    'scope',
    'body',
    'run',
    'user',
    'meta',
  ];

  const forwardedRequest = await createForwardRequest(originalRequest, forwardedHeaders, {
    stripQueryParams: stripParams,
  });
  let executionCtx: Context['executionCtx'] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }

  let env: Context['env'] | undefined;
  try {
    env = c.env;
  } catch {
    env = undefined;
  }

  const timeoutPromise = new Promise<Response>((_, reject) =>
    setTimeout(() => reject(new Error('Request to Portkey timed out')), 30000)
  );

  const response = await Promise.race([
    portkeyApp.fetch(forwardedRequest, env, executionCtx),
    timeoutPromise
  ]);
  if (process.env.DEBUG_GATEWAY_FORWARD === '1') {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    console.log('Portkey response status', response.status);
    console.log('Portkey response body', bodyText);
  }
  return adaptResponse(response);
};

if (llmLimiter) {
  app.use('/llm', verifySignedUrlMiddleware, llmLimiter);
  app.use('/llm/*', verifySignedUrlMiddleware, llmLimiter);
} else {
  app.use('/llm', verifySignedUrlMiddleware);
  app.use('/llm/*', verifySignedUrlMiddleware);
}
app.all('/llm', handlePortkey);
app.all('/llm/*', handlePortkey);

export default app;

async function hashRequestBody(request: Request): Promise<string> {
  const clone = request.clone();
  const buffer = Buffer.from(await clone.arrayBuffer());
  return createHash('sha256').update(buffer).digest('hex');
}
