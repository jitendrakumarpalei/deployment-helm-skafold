import { Pool } from 'pg';

export interface ClassificationJob {
  job_id: number;
  log_id: string;
  prompt_content: string | null;
  inserted_at: string;
  attempts: number;
}

export class ClassificationQueue {
  private readonly reservationTimeoutSeconds: number;
  private readonly retentionSeconds: number;

  constructor(
    private readonly pool: Pool,
    reservationTimeoutMs: number = 300_000,
    retentionMs: number = 86_400_000
  ) {
    this.reservationTimeoutSeconds = Math.max(
      Math.floor(reservationTimeoutMs / 1000),
      60
    );
    this.retentionSeconds = Math.max(
      Math.floor(retentionMs / 1000),
      3_600
    );
  }

  async lease(batchSize: number): Promise<ClassificationJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM classification_jobs WHERE inserted_at < now() - ($1::int * INTERVAL \'1 second\')',
        [this.retentionSeconds]
      );
      const { rows } = await client.query(
        `WITH selected AS (
           SELECT job_id
           FROM classification_jobs
           WHERE reserved_at IS NULL
              OR reserved_at < now() - ($2::int * INTERVAL '1 second')
           ORDER BY inserted_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE classification_jobs
         SET reserved_at = now(),
             attempts = attempts + 1
         WHERE job_id IN (SELECT job_id FROM selected)
         RETURNING job_id, log_id, prompt_content, inserted_at, attempts;
        `,
        [batchSize, this.reservationTimeoutSeconds]
      );
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(jobIds: number[]): Promise<void> {
    if (jobIds.length === 0) {
      return;
    }
    await this.pool.query(
      'DELETE FROM classification_jobs WHERE job_id = ANY($1::bigint[])',
      [jobIds]
    );
  }

  async release(jobId: number): Promise<void> {
    await this.pool.query(
      'UPDATE classification_jobs SET reserved_at = NULL WHERE job_id = $1',
      [jobId]
    );
  }

  async moveToDLQ(job: ClassificationJob, error: Error): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO classification_jobs_failed (original_job_id, log_id, prompt_content, attempts, error_details)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.job_id, job.log_id, job.prompt_content, job.attempts, { message: error.message, stack: error.stack }]
      );
      await client.query('DELETE FROM classification_jobs WHERE job_id = $1', [job.job_id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
