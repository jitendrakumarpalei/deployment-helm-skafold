import { Hono } from 'hono';
import { getPool, withClient } from './db.js';

const controlApp = new Hono();

controlApp.get('/healthz', (c) => c.json({ status: 'ok' }));

function extractApiKey(c: any): string | null {
  const auth = c.req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) {
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

controlApp.get('/v2/models', async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    return c.json({ message: 'Missing API key' }, 401);
  }

  const pool = getPool();
  const clientRow = await pool.query(
    'SELECT id FROM api_clients WHERE api_key = $1',
    [apiKey]
  );
  if (clientRow.rows.length === 0) {
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

controlApp.get('/v1/account/config', async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    return c.json({ message: 'Missing API key' }, 401);
  }

  const providerFilter = c.req.query('provider');
  const pool = getPool();
  const clientResult = await pool.query(
    'SELECT id FROM api_clients WHERE api_key = $1',
    [apiKey]
  );
  if (clientResult.rows.length === 0) {
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

function forwardToControl(c: import('hono').Context) {
  const url = new URL(c.req.url);
  const stripped = url.pathname.replace(/^\/control/, '') || '/';
  url.pathname = stripped.startsWith('/') ? stripped : `/${stripped}`;
  const forwarded = new Request(url.toString(), c.req.raw);
  return controlApp.fetch(forwarded);
}

const app = new Hono();
app.route('/', controlApp);
app.all('/control', (c) => forwardToControl(c));
app.all('/control/*', (c) => forwardToControl(c));

export default app;
