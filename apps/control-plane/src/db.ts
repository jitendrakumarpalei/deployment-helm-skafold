import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(connectionString?: string): Pool {
  if (pool) {
    return pool;
  }
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to use the control plane');
  }
  pool = new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  return pool;
}

export async function withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const db = getPool();
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
