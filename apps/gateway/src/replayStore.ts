import { Pool } from 'pg';

const connectionString = process.env.SIGNED_URL_DATABASE_URL ?? process.env.DATABASE_URL;
let pool: Pool | undefined;

if (connectionString) {
  pool = new Pool({ connectionString });
}

const memoryStore = new Map<string, number>();

export async function assertNonce(sessionId: string, nonce: string, expiresAt: number): Promise<void> {
  const key = `${sessionId}:${nonce}`;
  const now = Math.floor(Date.now() / 1000);

  if (pool) {
    await pool.query('DELETE FROM signed_url_replays WHERE expires_at < NOW()');
    const result = await pool.query(
      `INSERT INTO signed_url_replays (session_id, nonce, expires_at)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      [sessionId, nonce, expiresAt]
    );
    if (result.rowCount === 0) {
      throw new Error('Signed URL replay detected');
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
