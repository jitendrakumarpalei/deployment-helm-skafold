import { Pool } from 'pg';

const connectionString = process.env.SIGNED_URL_DATABASE_URL ?? process.env.DATABASE_URL;
export let pool: Pool | undefined;

if (connectionString) {
  pool = new Pool({ connectionString });
}

const memoryStore = new Map<string, number>();

export async function closeReplayStorePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}

export async function initializePool(connectionString: string): Promise<void> {
  if (pool) {
    await pool.end();
  }
  pool = new Pool({ connectionString });
}

export async function assertNonce(sessionId: string, nonce: string, expiresAt: number): Promise<void> {
  const key = `${sessionId}:${nonce}`;
  const now = Math.floor(Date.now() / 1000);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM signed_url_replays WHERE expires_at < NOW()');
      const result = await client.query(
        `INSERT INTO signed_url_replays (session_id, nonce, expires_at)
         VALUES ($1, $2, to_timestamp($3))
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [sessionId, nonce, expiresAt]
      );
      await client.query('COMMIT');
      if (result.rowCount === 0) {
        throw new Error('Signed URL replay detected');
      }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return;
  }

  // Fallback in-memory cache for environments without database access.
  for (const [entry, expiry] of memoryStore.entries()) {
    if (expiry < now) {
      memoryStore.delete(entry);
    }
  }
  if (memoryStore.has(key)) {
    throw new Error('Signed URL replay detected');
  }
  memoryStore.set(key, expiresAt);
}
