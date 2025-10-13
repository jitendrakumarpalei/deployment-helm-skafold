import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { startWorker } from '../../apps/worker/src/worker';

let pgContainer: PostgreSqlContainer | undefined;
let pool: Pool;
let databaseUrl: string;

async function resetDatabase(url: string) {
  const pool = new Pool({ connectionString: url });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.end();
}

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

  await resetDatabase(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.META_LLM_CLASSIFIER_ENDPOINT = 'http://classifier.local';
  process.env.META_LLM_API_KEY = 'dummy';

  await runMigrations({ databaseUrl });

  pool = new Pool({ connectionString: databaseUrl });

  await pool.query(
    `INSERT INTO ledger_events(event_id, run_id, user_id, outcome)
     VALUES ($1, $2, $3, $4)`,
    ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'user-xyz', 'success']
  );

  await pool.query(
    `INSERT INTO classification_jobs (log_id, prompt_content)
     VALUES ($1, $2)`,
    ['11111111-1111-1111-1111-111111111111', 'Classify me']
  );
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (pgContainer) {
    await pgContainer.stop();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Classification worker', () => {
  it('updates ledger events with classifier results', async () => {
    const classifierSpy = vi
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, json: async () => ({ action_type: 'synthesis' }) } as Response);

    const intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((fn) => {
      void fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    const worker = await startWorker();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const record = await pool.query(
      'SELECT action_type FROM ledger_events WHERE event_id = $1',
      ['11111111-1111-1111-1111-111111111111']
    );

    expect(record.rows[0].action_type).toBe('synthesis');
    expect(classifierSpy).toHaveBeenCalled();
    expect(intervalSpy).toHaveBeenCalled();

    const remainingJobs = await pool.query('SELECT COUNT(*)::int AS count FROM classification_jobs');
    expect(remainingJobs.rows[0].count).toBe(0);

    await worker.stop();
  }, 30_000);
});
