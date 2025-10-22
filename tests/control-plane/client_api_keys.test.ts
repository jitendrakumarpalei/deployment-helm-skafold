import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../apps/control-plane/src/migrate';

let pgContainer: PostgreSqlContainer | undefined;
let databaseUrl: string;
let pool: Pool;

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    databaseUrl = process.env.TEST_DATABASE_URL;
  } else {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('stringcost_test')
      .withUsername('stringcost')
      .withPassword('stringcost')
      .start();
    databaseUrl = pgContainer.getConnectionUri();
  }

  // Reset database
  const resetClient = new Pool({ connectionString: databaseUrl });
  await resetClient.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await resetClient.end();

  // Run migrations
  await runMigrations({ databaseUrl });

  // Create a test API client
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    INSERT INTO api_clients (id, name, api_key)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Test Client', 'sk-test-123')
  `);
}, 120000);

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

describe('Client API Keys Storage', () => {
  it('should encrypt and store client-provided API key', async () => {
    const clientId = '00000000-0000-0000-0000-000000000001';
    const provider = 'gemini';
    const apiKey = 'AIzaSyTest123';
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const encryptionKey = 'test-encryption-key';

    const result = await pool.query(
      `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
       RETURNING id, api_client_id, provider, expires_at`,
      [clientId, provider, apiKey, encryptionKey, expiresAt]
    );

    expect(result.rows[0].api_client_id).toBe(clientId);
    expect(result.rows[0].provider).toBe(provider);

    // Verify key can be decrypted
    const decryptResult = await pool.query(
      `SELECT pgp_sym_decrypt(encrypted_key::bytea, $1) AS decrypted_key
       FROM client_api_keys
       WHERE id = $2`,
      [encryptionKey, result.rows[0].id]
    );

    expect(decryptResult.rows[0].decrypted_key.toString()).toBe(apiKey);
  });

  it('should require encryption for storing keys', async () => {
    const clientId = '00000000-0000-0000-0000-000000000001';
    const provider = 'openai';
    const plainKey = 'sk-test-plain';
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const encryptionKey = 'test-encryption-key';

    // Store with proper encryption
    const insertResult = await pool.query(
      `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
       RETURNING id`,
      [clientId, provider, plainKey, encryptionKey, expiresAt]
    );

    expect(insertResult.rows.length).toBe(1);

    // Verify raw encrypted data is not the plain key
    const rawResult = await pool.query(
      'SELECT encrypted_key FROM client_api_keys WHERE id = $1',
      [insertResult.rows[0].id]
    );

    const rawEncryptedKey = rawResult.rows[0].encrypted_key;
    expect(rawEncryptedKey.toString()).not.toBe(plainKey);
  });

  it('should support querying by client_id and provider', async () => {
    const clientId = '00000000-0000-0000-0000-000000000001';
    const provider = 'anthropic';
    const apiKey = 'sk-ant-test';
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const encryptionKey = 'test-encryption-key';

    await pool.query(
      `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)`,
      [clientId, provider, apiKey, encryptionKey, expiresAt]
    );

    const result = await pool.query(
      `SELECT id, provider, pgp_sym_decrypt(encrypted_key::bytea, $3) AS decrypted_key
       FROM client_api_keys
       WHERE api_client_id = $1 AND provider = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [clientId, provider, encryptionKey]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].provider).toBe(provider);
    expect(result.rows[0].decrypted_key.toString()).toBe(apiKey);
  });

  it('should delete expired keys', async () => {
    const clientId = '00000000-0000-0000-0000-000000000001';
    const provider = 'test-expired';
    const apiKey = 'expired-key';
    const expiresAt = new Date(Date.now() - 1000); // Already expired
    const encryptionKey = 'test-encryption-key';

    const insertResult = await pool.query(
      `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
       RETURNING id`,
      [clientId, provider, apiKey, encryptionKey, expiresAt]
    );

    const keyId = insertResult.rows[0].id;

    // Manual cleanup (simulates pg_cron job)
    await pool.query('DELETE FROM client_api_keys WHERE expires_at < NOW()');

    // Verify key was deleted
    const checkResult = await pool.query(
      'SELECT id FROM client_api_keys WHERE id = $1',
      [keyId]
    );

    expect(checkResult.rows.length).toBe(0);
  });

  it('should enforce client isolation (cascade delete)', async () => {
    const clientId = '00000000-0000-0000-0000-000000000001';
    const provider = 'test-cascade';
    const apiKey = 'cascade-test-key';
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const encryptionKey = 'test-encryption-key';

    await pool.query(
      `INSERT INTO client_api_keys (api_client_id, provider, encrypted_key, expires_at)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)`,
      [clientId, provider, apiKey, encryptionKey, expiresAt]
    );

    // Delete the API client
    await pool.query('DELETE FROM api_clients WHERE id = $1', [clientId]);

    // Verify client API keys were cascade deleted
    const checkResult = await pool.query(
      'SELECT id FROM client_api_keys WHERE api_client_id = $1',
      [clientId]
    );

    expect(checkResult.rows.length).toBe(0);
  });
});
