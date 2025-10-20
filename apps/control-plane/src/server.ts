import { Hono } from 'hono';
import { getPool } from './db.js';
import { createSignedUrl } from '@stringcost/shared/signedUrl';

const controlRoutes = new Hono();

controlRoutes.get('/healthz', (c) => c.json({ status: 'ok' }));

function extractApiKey(c: any): string | null {
  const auth = c.req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    if (process.env.DEBUG_CONTROL_PLANE === '1') {
      console.log('Authorization header detected');
    }
    return auth.slice('Bearer '.length).trim();
  }
  return c.req.header('x-stringcost-api-key') || null;
}

interface ProviderModelRow {
  provider: string;
  virtual_key: string;
  model_name: string;
  display_name: string | null;
  description: string | null;
}

interface ProviderCredentialRow {
  provider: string;
  virtual_key: string;
  provider_api_key: string;
  metadata: unknown;
}

controlRoutes.get('/v2/models', async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    if (process.env.DEBUG_CONTROL_PLANE === '1') {
      console.error('Control plane: missing API key');
      console.error('Headers:', Object.fromEntries(c.req.raw.headers));
    }
    return c.json({ message: 'Missing API key' }, 401);
  }

  const pool = getPool();
  const clientRow = await pool.query(
    'SELECT id FROM api_clients WHERE api_key = $1',
    [apiKey]
  );
  if (clientRow.rows.length === 0) {
    if (process.env.DEBUG_CONTROL_PLANE === '1') {
      console.error('Control plane: invalid API key', apiKey);
    }
    return c.json({ message: 'Invalid API key' }, 403);
  }
  const clientId = clientRow.rows[0].id;

  const { rows } = await pool.query<ProviderModelRow>(
    `SELECT pc.provider, pc.virtual_key, pm.model_name, pm.display_name, pm.description
       FROM provider_credentials pc
       JOIN provider_models pm ON pm.provider = pc.provider
      WHERE pc.api_client_id = $1
      ORDER BY pm.provider, pm.model_name`,
    [clientId]
  );

  const data = rows.map((row) => ({
    id: row.model_name,
    object: 'model',
    provider: row.provider,
    owned_by: row.provider,
    display_name: row.display_name ?? row.model_name,
    description: row.description ?? '',
    virtual_key: row.virtual_key,
  }));

  return c.json({ data });
});

controlRoutes.get('/v1/account/config', async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    if (process.env.DEBUG_CONTROL_PLANE === '1') {
      console.error('Control plane: missing API key');
      console.error('Headers:', Object.fromEntries(c.req.raw.headers));
    }
    return c.json({ message: 'Missing API key' }, 401);
  }

  const providerFilter = c.req.query('provider');
  const pool = getPool();
  const clientResult = await pool.query(
    'SELECT id FROM api_clients WHERE api_key = $1',
    [apiKey]
  );
  if (clientResult.rows.length === 0) {
    if (process.env.DEBUG_CONTROL_PLANE === '1') {
      console.error('Control plane: invalid API key', apiKey);
    }
    return c.json({ message: 'Invalid API key' }, 403);
  }
  const clientId = clientResult.rows[0].id;

  const credentialResult = await pool.query<ProviderCredentialRow>(
    `SELECT provider, virtual_key, provider_api_key, metadata
       FROM provider_credentials
      WHERE api_client_id = $1
        AND ($2::text IS NULL OR provider = $2)
      ORDER BY created_at ASC
      LIMIT 1`,
    [clientId, providerFilter ?? null]
  );

  if (credentialResult.rows.length === 0) {
    return c.json({ message: 'No provider configured' }, 404);
  }

  const cred = credentialResult.rows[0];
  const config = {
    provider: cred.provider,
    virtual_key: cred.virtual_key,
    config: {
      api_key: cred.provider_api_key,
    },
    metadata: cred.metadata || {},
  };

  return c.json({ provider: cred.provider, config });
});

interface PresignRequestBody {
  method?: string;
  path: string;
  provider?: string;
  virtual_key?: string;
  run_id?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
  body_sha256?: string;
  expires_in?: number;
  config?: Record<string, unknown>;
  session_id?: string;
  scope?: string;
  nonce?: string;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizePath(input: string): string {
  if (!input) {
    throw new Error('Path is required');
  }
  if (!input.startsWith('/')) {
    return `/${input}`;
  }
  return input;
}

function resolveGatewayBase(): string {
  const base = process.env.GATEWAY_BASE_URL ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787';
  return base.replace(/\/+$/u, '');
}

controlRoutes.post('/v1/presign', async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    return c.json({ message: 'Missing API key' }, 401);
  }

  const body = (await c.req.json()) as PresignRequestBody;
  const method = (body.method ?? 'POST').toUpperCase();
  let path: string;
  try {
    path = normalizePath(body.path);
  } catch (error) {
    return c.json({ message: (error as Error).message }, 400);
  }
  const requestedProvider = body.provider;
  const requestedVirtualKey = body.virtual_key;

  const pool = getPool();
  const clientResult = await pool.query(
    'SELECT id FROM api_clients WHERE api_key = $1',
    [apiKey]
  );
  if (clientResult.rows.length === 0) {
    return c.json({ message: 'Invalid API key' }, 403);
  }
  const clientId = clientResult.rows[0].id as string;

  let credentialQuery: string;
  let credentialParams: unknown[];
  if (requestedVirtualKey) {
    credentialQuery = `SELECT provider, virtual_key, provider_api_key, metadata
       FROM provider_credentials
      WHERE api_client_id = $1
        AND virtual_key = $2
      LIMIT 1`;
    credentialParams = [clientId, requestedVirtualKey];
  } else {
    if (!requestedProvider) {
      return c.json({ message: 'provider or virtual_key is required' }, 400);
    }
    credentialQuery = `SELECT provider, virtual_key, provider_api_key, metadata
       FROM provider_credentials
      WHERE api_client_id = $1
        AND provider = $2
      ORDER BY created_at ASC
      LIMIT 1`;
    credentialParams = [clientId, requestedProvider];
  }

  const credentialResult = await pool.query<ProviderCredentialRow>(
    credentialQuery,
    credentialParams
  );

  if (credentialResult.rows.length === 0) {
    return c.json({ message: 'No provider configuration available' }, 404);
  }

  const cred = credentialResult.rows[0];
  const overrides =
    body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? body.config
      : {};

  const routeConfig: Record<string, unknown> = {
    ...overrides,
    provider: (overrides as Record<string, unknown>).provider ?? cred.provider,
    api_key: cred.provider_api_key,
    virtual_key: cred.virtual_key ?? undefined,
    credential_metadata: cred.metadata ?? undefined,
  };

  if (typeof routeConfig.provider !== 'string') {
    routeConfig.provider = cred.provider;
  }

  if (body.body_sha256 && !/^[a-f0-9]{64}$/iu.test(body.body_sha256)) {
    return c.json({ message: 'body_sha256 must be a hex-encoded SHA-256 digest' }, 400);
  }

  const metadata = sanitizeMetadata(body.metadata);
  const baseUrl = resolveGatewayBase();
  const canonicalHost = new URL(baseUrl).host;

  const signed = createSignedUrl({
    method,
    host: canonicalHost,
    path,
    bodyHash: body.body_sha256?.toLowerCase(),
    clientId,
    provider: cred.provider,
    scope: body.scope,
    sessionId: body.session_id,
    runId: body.run_id,
    userId: body.user_id,
    metadata,
    nonce: body.nonce,
    expiresIn: body.expires_in,
    routeConfig,
  });

  const presignedUrl = new URL(`${baseUrl}/llm${path}`);
  signed.params.forEach((value: string, key: string) => presignedUrl.searchParams.set(key, value));

  return c.json({
    url: presignedUrl.toString(),
    expires_at: signed.expiresAt,
    session_id: signed.sessionId,
    nonce: signed.nonce,
    kid: signed.params.get('kid'),
  });
});

const app = new Hono();
app.route('/', controlRoutes);
app.route('/control', controlRoutes);

export default app;
