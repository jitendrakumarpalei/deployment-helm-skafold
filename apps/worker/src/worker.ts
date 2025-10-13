import Redis from 'ioredis';
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

export async function startWorker(): Promise<{ stop: () => Promise<void> }> {
  const config = loadConfig();

  const redis = new Redis(config.redisUrl);
  const queue = new ClassificationQueue(redis, config.queueKey);
  const pool = new Pool({ connectionString: config.databaseUrl });

  const processBatch = () => processJobs(queue, pool, config);

  await processBatch();
  const timer = setInterval(processBatch, config.pollIntervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      await redis.quit();
      await pool.end();
    },
  };
}

async function processJobs(
  queue: ClassificationQueue,
  pool: Pool,
  config: WorkerConfig
): Promise<void> {
  const jobs = await queue.dequeue(config.batchSize);
  if (jobs.length === 0) {
    return;
  }

  for (const job of jobs) {
    try {
      const classification = await classifyPrompt(
        config.classificationEndpoint,
        config.classificationApiKey,
        { logId: job.logId, promptContent: job.promptContent }
      );
      await updateLedgerActionType(pool, job.logId, classification.action_type);
    } catch (error) {
      console.error('Failed to classify job', job.logId, error);
    }
  }
}

export async function runWorkerOnce(): Promise<void> {
  const config = loadConfig();
  const redis = new Redis(config.redisUrl);
  const queue = new ClassificationQueue(redis, config.queueKey);
  const pool = new Pool({ connectionString: config.databaseUrl });

  try {
    await processJobs(queue, pool, config);
  } finally {
    await redis.quit();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err) => {
    console.error('Worker failed to start', err);
    process.exit(1);
  });
}
