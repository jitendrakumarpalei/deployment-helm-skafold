export interface WorkerConfig {
  databaseUrl: string;
  pollIntervalMs: number;
  batchSize: number;
  classificationEndpoint: string;
  classificationApiKey?: string;
  reservationTimeoutMs: number;
  retentionMs: number;
}

export function loadConfig(): WorkerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const classificationEndpoint = process.env.META_LLM_CLASSIFIER_ENDPOINT;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be defined');
  }
  if (!classificationEndpoint) {
    throw new Error('META_LLM_CLASSIFIER_ENDPOINT must be defined');
  }

  return {
    databaseUrl,
    pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000),
    batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 10),
    classificationEndpoint,
    classificationApiKey: process.env.META_LLM_API_KEY,
    reservationTimeoutMs: Number(process.env.WORKER_RESERVATION_TIMEOUT_MS ?? 300000),
    retentionMs: Number(process.env.WORKER_RETENTION_MS ?? 86_400_000),
  };
}
