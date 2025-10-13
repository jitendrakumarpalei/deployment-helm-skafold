import { Hono, type Context } from 'hono';
import portkeyApp from '../../../vendor/portkey-gateway/src/index';
import { adaptResponse } from './middleware/responseAdapter';
import { createForwardRequest, enrichRequestHeaders } from './middleware/requestAdapter';

function parseConfig(headerValue: string | null): any | null {
  if (!headerValue) return null;
  try {
    return JSON.parse(headerValue);
  } catch {
    return null;
  }
}

async function ensureProviderHeaders(headers: Headers): Promise<void> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? null;

  let provider = headers.get('x-stringcost-provider') ?? undefined;
  const configHeader = headers.get('x-stringcost-config');
  const parsedConfig = parseConfig(configHeader);

  if (!provider && parsedConfig?.provider) {
    provider = parsedConfig.provider;
    headers.set('x-stringcost-provider', provider);
  }

  const hasConfig = Boolean(parsedConfig?.provider && parsedConfig?.config?.api_key);

  if (provider && hasConfig) {
    return;
  }

  if (!controlPlaneUrl) {
    if (!provider || !hasConfig) {
      throw new Error('Missing provider configuration and no control plane is configured.');
    }
    return;
  }

  const authHeader = headers.get('authorization');
  const apiKeyHeader = headers.get('x-stringcost-api-key');
  if (!authHeader && !apiKeyHeader) {
    throw new Error('Missing Authorization or x-stringcost-api-key header for control plane resolution.');
  }

  const controlHeaders = new Headers();
  if (authHeader) controlHeaders.set('authorization', authHeader);
  if (apiKeyHeader) controlHeaders.set('x-stringcost-api-key', apiKeyHeader);

  const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const resp = await fetch(`${controlPlaneUrl.replace(/\/$/, '')}/v1/account/config${query}`, {
    headers: controlHeaders,
  });

  if (!resp.ok) {
    const errorBody = await resp.text();
    throw new Error(`Control plane error (${resp.status}): ${errorBody}`);
  }

  const data = await resp.json();
  const resolvedConfig = data?.config;
  if (!resolvedConfig?.provider) {
    throw new Error('Control plane response missing provider configuration.');
  }

  headers.set('x-stringcost-provider', resolvedConfig.provider);
  headers.set('x-stringcost-config', JSON.stringify(resolvedConfig));
}

const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const handlePortkey = async (c: Context) => {
  const original = c.req.raw;
  const headers = new Headers(original.headers);

  try {
    await ensureProviderHeaders(headers);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : 'Failed to resolve provider configuration';
    return c.json({ message }, 502);
  }

  const forwardedRequest = await createForwardRequest(original, headers);
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
