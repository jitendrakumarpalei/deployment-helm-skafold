import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../../apps/ledger/src/migrate';
import { startWorker, runWorkerOnce } from '../../apps/worker/src/worker';
import { runLedgerSeeds } from '../helpers/seeds';

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
  await runLedgerSeeds(databaseUrl);

  pool = new Pool({ connectionString: databaseUrl });
});

async function insertTestJob() {
  await pool.query(
    `DELETE FROM classification_jobs WHERE log_id = $1`,
    ['11111111-1111-1111-1111-111111111111']
  );
  await pool.query(
    `DELETE FROM classification_jobs_failed WHERE log_id = $1`,
    ['11111111-1111-1111-1111-111111111111']
  );
  await pool.query(
    `DELETE FROM ledger_events WHERE event_id = $1`,
    ['11111111-1111-1111-1111-111111111111']
  );

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
}

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
    await insertTestJob();

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

  it('releases a job if the classifier times out', async () => {
    await insertTestJob();

    const classifierSpy = vi.spyOn(global, 'fetch' as any).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50)); // Short timeout
      throw new Error('Timeout');
    });

    await runWorkerOnce(pool);

    const remainingJobs = await pool.query('SELECT COUNT(*)::int AS count FROM classification_jobs WHERE reserved_at IS NULL');
    expect(remainingJobs.rows[0].count).toBe(1);

    expect(classifierSpy).toHaveBeenCalled();
  }, 10000);

  it('moves a failing job to the dead letter queue after 5 attempts', async () => {
    await insertTestJob();

    vi.spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: false, status: 500 } as Response);

    // Manually run the worker 5 times to simulate retries
    for (let i = 0; i < 5; i++) {
      await runWorkerOnce(pool);
    }

    const failedJobs = await pool.query('SELECT * FROM classification_jobs_failed');
    expect(failedJobs.rowCount).toBe(1);
    expect(failedJobs.rows[0].log_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(failedJobs.rows[0].attempts).toBe(5);

    const remainingJobs = await pool.query('SELECT COUNT(*)::int AS count FROM classification_jobs');
    expect(remainingJobs.rows[0].count).toBe(0);
  }, 40000);
});
