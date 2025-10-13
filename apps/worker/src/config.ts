export interface WorkerConfig {
  redisUrl: string;
  databaseUrl: string;
  pollIntervalMs: number;
  batchSize: number;
  classificationEndpoint: string;
  classificationApiKey?: string;
  queueKey: string;
}

export function loadConfig(): WorkerConfig {
  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  const classificationEndpoint = process.env.META_LLM_CLASSIFIER_ENDPOINT;

  if (!redisUrl) {
    throw new Error('REDIS_URL must be defined');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be defined');
  }
  if (!classificationEndpoint) {
    throw new Error('META_LLM_CLASSIFIER_ENDPOINT must be defined');
  }

  return {
    redisUrl,
    databaseUrl,
    pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000),
    batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 10),
    classificationEndpoint,
    classificationApiKey: process.env.META_LLM_API_KEY,
    queueKey: process.env.CLASSIFICATION_QUEUE_KEY ?? 'classification_jobs',
  };
}
