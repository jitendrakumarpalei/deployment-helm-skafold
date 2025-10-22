import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getPool } from './db.js';
import { createSignedUrl } from '@stringcost/shared/signedUrl';
import { rateLimiter } from 'hono-rate-limiter';
import { PostgresStore } from '@acpr/rate-limit-postgresql';

const controlRoutes = new Hono();

controlRoutes.get('/healthz', (c) => c.json({ status: 'ok' }));
controlRoutes.get('/readyz', async (c) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return c.json({ status: 'ready' });
  } catch (error) {
    console.error('Readiness check failed:', error);
    return c.json({ status: 'not ready' }, 503);
  }
});

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

const presignLimiter = (process.env.DATABASE_URL && process.env.DISABLE_RATE_LIMITING !== 'true') ? rateLimiter({
  store: new PostgresStore({
    connectionString: process.env.DATABASE_URL,
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  keyGenerator: (c) => extractApiKey(c) ?? c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
}) : undefined;

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

  const knex = (await import('./knex.js')).default;
  const query = knex('provider_credentials')
    .select('provider', 'virtual_key', 'provider_api_key', 'metadata')
    .where('api_client_id', clientId)
    .orderBy('created_at', 'asc');

  if (providerFilter) {
    query.andWhere('provider', providerFilter);
  }

  const cred = await query.first<ProviderCredentialRow>();

  if (!cred) {
    return c.json({ message: 'No provider configured' }, 404);
  }

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

const presignRequestSchema = z.object({
  method: z.string().optional().default('POST'),
  path: z.string().min(1).max(2048),
  provider: z.string().optional(),
  virtual_key: z.string().optional(),
  client_api_key: z.string().optional(), // Client provides their own API key (stored temporarily)
  client_key_ttl: z.number().int().min(60).max(86400).optional().default(3600), // TTL for client key (1 hour default, max 24 hours)
  run_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional().refine((val) => {
    if (!val) return true;
    return JSON.stringify(val).length < 64 * 1024;
  }, { message: 'Metadata must be less than 64KB' }),
  body_sha256: z.string().optional(),
  expires_in: z.number().int().optional(),
  config: z.record(z.unknown()).optional(),
  session_id: z.string().uuid().optional(),
  scope: z.string().optional(),
  nonce: z.string().uuid().optional(),
});

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

controlRoutes.post(
  '/v1/presign',
  ...(presignLimiter ? [presignLimiter] : []),
  zValidator('json', presignRequestSchema),
  async (c) => {
    const apiKey = extractApiKey(c);
    if (!apiKey) {
      return c.json({ message: 'Missing API key' }, 401);
    }

    const body = c.req.valid('json');
    const method = body.method.toUpperCase();
    let path: string;
    try {
      path = normalizePath(body.path);
    } catch (error) {
      return c.json({ message: (error as Error).message }, 400);
    }
    const requestedProvider = body.provider;
    const requestedVirtualKey = body.virtual_key;
    const clientApiKey = body.client_api_key;
    const clientKeyTtl = body.client_key_ttl || 3600;

    const pool = getPool();
    const clientResult = await pool.query(
      'SELECT id FROM api_clients WHERE api_key = $1',
      [apiKey]
    );
    if (clientResult.rows.length === 0) {
      return c.json({ message: 'Invalid API key' }, 403);
    }
    const clientId = clientResult.rows[0].id as string;

    let provider: string;
    let providerApiKey: string;
    let virtualKey: string | undefined;
    let metadata: Record<string, unknown> | undefined;

    // If client provides their own API key, store it temporarily
    if (clientApiKey) {
      if (!requestedProvider) {
        return c.json({ message: 'provider is required when using client_api_key' }, 400);
      }
      provider = requestedProvider;

      // Encrypt and store the client API key temporarily
      const expiresAt = new Date(Date.now() + clientKeyTtl * 1000);
      const encryptionKey = process.env.DATABASE_ENCRYPTION_KEY || 'default-encryption-key-change-in-production';

      const insertResult = await pool.query(
        `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
         VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
         RETURNING id`,
        [clientId, provider, clientApiKey, encryptionKey, expiresAt]
      );

      const storedKeyId = insertResult.rows[0].id;

      // Use a reference ID as the virtual key
      virtualKey = `client-key-${storedKeyId}`;
      providerApiKey = clientApiKey;
      metadata = { client_provided: true, key_id: storedKeyId, expires_at: expiresAt.toISOString() };
    } else {
      // Use stored credentials
      const knex = (await import('./knex.js')).default;
      let query = knex('provider_credentials')
        .select('provider', 'virtual_key', 'provider_api_key', 'metadata')
        .where('api_client_id', clientId);

      if (requestedVirtualKey) {
        query = query.andWhere('virtual_key', requestedVirtualKey);
      } else {
        if (!requestedProvider) {
          return c.json({ message: 'provider or virtual_key is required' }, 400);
        }
        query = query.andWhere('provider', requestedProvider).orderBy('created_at', 'asc');
      }

      const cred = await query.first<ProviderCredentialRow>();

      if (!cred) {
        return c.json({ message: 'No provider configuration available' }, 404);
      }

      provider = cred.provider;
      providerApiKey = cred.provider_api_key;
      virtualKey = cred.virtual_key;
      metadata = cred.metadata as Record<string, unknown> | undefined;
    }

    const overrides =
      body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? body.config
        : {};

    const routeConfig: Record<string, unknown> = {
      ...overrides,
      provider: (overrides as Record<string, unknown>).provider ?? provider,
      api_key: providerApiKey,
      virtual_key: virtualKey ?? undefined,
      credential_metadata: metadata ?? undefined,
    };

    if (typeof routeConfig.provider !== 'string') {
      routeConfig.provider = provider;
    }

    if (body.body_sha256 && !/^[a-f0-9]{64}$/iu.test(body.body_sha256)) {
      return c.json({ message: 'body_sha256 must be a hex-encoded SHA-256 digest' }, 400);
    }

    const requestMetadata = body.metadata;
    const baseUrl = resolveGatewayBase();
    const canonicalHost = new URL(baseUrl).host;

    const signed = createSignedUrl({
      method,
      host: canonicalHost,
      path,
      bodyHash: body.body_sha256?.toLowerCase(),
      clientId,
      provider,
      scope: body.scope,
      sessionId: body.session_id,
      runId: body.run_id,
      userId: body.user_id,
      metadata: requestMetadata,
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
  }
);

import { cors } from 'hono/cors';

// ... (keep existing imports)

const app = new Hono();

app.use('*', cors({
  origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','),
}));

app.route('/', controlRoutes);
app.route('/control', controlRoutes);

export default app;
