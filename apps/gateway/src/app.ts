import { Hono, type Context } from 'hono';
import portkeyApp from '../../../vendor/portkey-gateway/src/index';
import { adaptResponse } from './middleware/responseAdapter';
import { createForwardRequest, enrichRequestHeaders } from './middleware/requestAdapter';

const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const handlePortkey = async (c: Context) => {
  const forwardedRequest = await createForwardRequest(c.req.raw);
  enrichRequestHeaders(forwardedRequest.headers);

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
  return adaptResponse(response);
};

app.all('/llm', handlePortkey);
app.all('/llm/*', handlePortkey);

export default app;
