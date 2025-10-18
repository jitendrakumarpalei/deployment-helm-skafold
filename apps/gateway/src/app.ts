import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import portkeyApp from '../../../vendor/portkey-gateway/src/index';
import { adaptResponse } from './middleware/responseAdapter';
import { createForwardRequest } from './middleware/requestAdapter';
import { unsealSignedRequest } from '../../shared/urlToken';

const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const handlePortkey = async (c: Context) => {
  const originalRequest = c.req.raw;
  const url = new URL(originalRequest.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return c.json({ message: 'Missing signed token' }, 400);
  }

  let payload;
  try {
    payload = unsealSignedRequest(token);
  } catch (error) {
    return c.json({ message: 'Invalid or expired token' }, 403);
  }

  const requestPath = c.req.path.startsWith('/llm') ? c.req.path.slice(4) || '/' : c.req.path;
  if (requestPath !== payload.path) {
    return c.json({ message: 'Token path mismatch' }, 403);
  }

  if (c.req.method.toUpperCase() !== payload.method) {
    return c.json({ message: 'Token method mismatch' }, 403);
  }

  if (payload.body_sha256) {
    const hashedBody = await hashRequestBody(originalRequest);
    if (hashedBody !== payload.body_sha256.toLowerCase()) {
      return c.json({ message: 'Request body hash mismatch' }, 400);
    }
  }

  const forwardedHeaders = new Headers(originalRequest.headers);
  forwardedHeaders.set('x-portkey-provider', payload.provider);
  forwardedHeaders.set('x-portkey-config', JSON.stringify(payload.route_config));
  if (payload.virtual_key) {
    forwardedHeaders.set('x-portkey-virtual-key', payload.virtual_key);
  }
  if (payload.run_id) {
    forwardedHeaders.set('x-stringcost-run-id', payload.run_id);
  }
  if (payload.user_id) {
    forwardedHeaders.set('x-stringcost-user-id', payload.user_id);
  }
  if (payload.metadata) {
    forwardedHeaders.set('x-stringcost-metadata', JSON.stringify(payload.metadata));
  }

  const forwardedRequest = await createForwardRequest(originalRequest, forwardedHeaders, {
    stripQueryParams: ['token'],
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
