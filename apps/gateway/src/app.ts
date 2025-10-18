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
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const defaultControlPlaneUrl = projectId
    ? `https://control-plane-dot-${projectId}.appspot.com`
    : null;
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? defaultControlPlaneUrl;

  if (!process.env.ALBUS_BASEPATH && controlPlaneUrl) {
    process.env.ALBUS_BASEPATH = controlPlaneUrl;
  }

  let provider = headers.get('x-stringcost-provider') ?? undefined;
  const configHeader = headers.get('x-stringcost-config');
  const parsedConfig = parseConfig(configHeader);

  if (!provider && parsedConfig?.provider) {
    provider = parsedConfig.provider;
    headers.set('x-stringcost-provider', provider);
  }

  const hasConfig =
    Boolean(parsedConfig?.provider && parsedConfig?.api_key) ||
    Boolean(parsedConfig?.provider && parsedConfig?.config?.api_key);

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
  const baseControlPlaneUrl = controlPlaneUrl!;
  const resp = await fetch(`${baseControlPlaneUrl.replace(/\/$/, '')}/v1/account/config${query}`, {
    headers: controlHeaders,
  });

  if (!resp.ok) {
    const errorBody = await resp.text();
    console.error('Control plane configuration fetch failed', resp.status, errorBody);
    throw new Error(`Control plane error (${resp.status}): ${errorBody}`);
  }

  const data = await resp.json();
  if (process.env.DEBUG_GATEWAY_CONFIG === '1') {
    console.log('Resolved config from control plane', JSON.stringify(data));
  }
  const resolvedConfig = data?.config ?? {};
  const resolvedProvider =
    resolvedConfig.provider ?? provider ?? data?.provider;
  const resolvedApiKey =
    resolvedConfig.api_key ?? resolvedConfig.config?.api_key ?? null;
  const resolvedVirtualKey =
    resolvedConfig.virtual_key ?? resolvedConfig.config?.virtual_key ?? null;

  if (!resolvedProvider || !resolvedApiKey) {
    throw new Error('Control plane response missing provider configuration.');
  }

  const normalizedConfig = {
    ...(resolvedConfig.config ?? {}),
    provider: resolvedProvider,
    api_key: resolvedApiKey,
  };

  headers.set('x-stringcost-provider', resolvedProvider);
  if (resolvedVirtualKey) {
    headers.set('x-stringcost-virtual-key', resolvedVirtualKey);
  }
  headers.set('x-stringcost-config', JSON.stringify(normalizedConfig));
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
