import { Pool } from 'pg';
import { ClassificationQueue } from './queue.js';
import { classifyPrompt } from './classifier.js';
import { loadConfig } from './config.js';
import type { WorkerConfig } from './config.js';

async function updateLedgerActionType(
  pool: Pool,
  logId: string,
  actionType: string
): Promise<void> {
  await pool.query(
    `UPDATE ledger_events
     SET action_type = $1
     WHERE event_id = $2`,
    [actionType, logId]
  );
}

export async function startWorker(): Promise<{ stop: () => Promise<void>; pool: Pool }> {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  const queue = new ClassificationQueue(
    pool,
    config.reservationTimeoutMs,
    config.retentionMs
  );

  const processBatch = () => processJobs(queue, pool, config);

  await processBatch();
  const timer = setInterval(processBatch, config.pollIntervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      await pool.end();
    },
    pool,
  };
}

async function processJobs(
  queue: ClassificationQueue,
  pool: Pool,
  config: WorkerConfig
): Promise<void> {
  const jobs = await queue.lease(config.batchSize);
  if (jobs.length === 0) {
    return;
  }

  const completedJobIds: number[] = [];
  const maxAttempts = 5;
  for (const job of jobs) {
    try {
      const classification = await classifyPrompt(
        config.classificationEndpoint,
        config.classificationApiKey,
        { logId: job.log_id, promptContent: job.prompt_content ?? '' }
      );
      await updateLedgerActionType(pool, job.log_id, classification.action_type);
      completedJobIds.push(job.job_id);
    } catch (error) {
      console.error('Failed to classify job', job.log_id, error);
      if (job.attempts >= maxAttempts) {
        await queue.moveToDLQ(job, error as Error);
      } else {
        await queue.release(job.job_id);
      }
    }
  }

  if (completedJobIds.length > 0) {
    await queue.complete(completedJobIds);
  }
}

export async function runWorkerOnce(existingPool?: Pool): Promise<void> {
  const config = loadConfig();
  const pool = existingPool ?? new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  const queue = new ClassificationQueue(
    pool,
    config.reservationTimeoutMs,
    config.retentionMs
  );

  try {
    await processJobs(queue, pool, config);
  } finally {
    if (!existingPool) {
      await pool.end();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err) => {
    console.error('Worker failed to start', err);
    process.exit(1);
  });
}
