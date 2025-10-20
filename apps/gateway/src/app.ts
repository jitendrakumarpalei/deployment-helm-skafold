import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import portkeyApp from '../../../vendor/portkey-gateway/src/index';
import { adaptResponse } from './middleware/responseAdapter';
import { createForwardRequest } from './middleware/requestAdapter';
import { verifySignedRequest } from '@stringcost/shared/signedUrl';
import { assertNonce } from './replayStore';

const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const handlePortkey = async (c: Context) => {
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

  const response = await portkeyApp.fetch(forwardedRequest, env, executionCtx);
  if (process.env.DEBUG_GATEWAY_FORWARD === '1') {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    console.log('Portkey response status', response.status);
    console.log('Portkey response body', bodyText);
  }
  return adaptResponse(response);
};

app.all('/llm', handlePortkey);
app.all('/llm/*', handlePortkey);

export default app;

async function hashRequestBody(request: Request): Promise<string> {
  const clone = request.clone();
  const buffer = Buffer.from(await clone.arrayBuffer());
  return createHash('sha256').update(buffer).digest('hex');
}
