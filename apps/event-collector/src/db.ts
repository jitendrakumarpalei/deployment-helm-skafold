import { Pool, PoolClient, QueryResult } from 'pg';

export interface LedgerEventInsert {
  run_id: string;
  user_id: string;
  step_name?: string;
  action_type?: string;
  outcome: string;
  duration_ms?: number;
  cost_cogs_micros?: number;
  revenue_billed_micros?: number;
  metadata?: unknown;
  timestamp?: Date;
}

export interface LedgerEventRecord {
  event_id: string;
  run_id: string;
  user_id: string;
  timestamp: Date;
  step_name: string | null;
  action_type: string;
  outcome: string;
  duration_ms: number | null;
  cost_cogs_micros: string;
  revenue_billed_micros: string;
  metadata: unknown;
}

export class LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async insertEvent(event: LedgerEventInsert): Promise<LedgerEventRecord> {
    const client = await this.pool.connect();
    try {
      const result: QueryResult<LedgerEventRecord> = await client.query(
        `INSERT INTO ledger_events (
            run_id,
            user_id,
            timestamp,
            step_name,
            action_type,
            outcome,
            duration_ms,
            cost_cogs_micros,
            revenue_billed_micros,
            metadata
         ) VALUES (
            $1,
            $2,
            COALESCE($3::timestamptz, now()),
            $4,
            COALESCE($5, 'unknown'),
            $6,
            $7,
            COALESCE($8, 0),
            COALESCE($9, 0),
            $10
         ) RETURNING *`,
        [
          event.run_id,
          event.user_id,
          event.timestamp ?? null,
          event.step_name ?? null,
          event.action_type ?? null,
          event.outcome,
          event.duration_ms ?? null,
          event.cost_cogs_micros ?? null,
          event.revenue_billed_micros ?? null,
          event.metadata ?? null
        ]
      );

      return result.rows[0];
    } finally {
      client.release();
    }
  }
}

export function createPool(connectionString?: string): Pool {
  const connection = connectionString ?? process.env.DATABASE_URL;
  if (!connection) {
    throw new Error('DATABASE_URL must be defined');
  }
  return new Pool({
    connectionString: connection,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export async function enqueueClassificationJob(
  pool: Pool,
  job: { logId: string; promptContent: string | null }
): Promise<void> {
  await pool.query(
    `INSERT INTO classification_jobs (log_id, prompt_content)
     VALUES ($1, $2)
     ON CONFLICT (log_id) DO UPDATE SET
       prompt_content = EXCLUDED.prompt_content,
       inserted_at = now(),
       reserved_at = NULL,
       attempts = 0`,
    [job.logId, job.promptContent]
  );
}
