runtime: nodejs22
service: worker
entrypoint: npm start
basic_scaling:
  max_instances: 1
  idle_timeout: 10m
vpc_access_connector:
  name: ${VPC_CONNECTOR}
beta_settings:
  cloud_sql_instances: ${CLOUD_SQL_INSTANCE}
env_variables:
  NODE_ENV: production
  DATABASE_URL: ${DATABASE_URL}
  META_LLM_CLASSIFIER_ENDPOINT: ${META_LLM_CLASSIFIER_ENDPOINT}
  META_LLM_API_KEY: ${META_LLM_API_KEY}
  WORKER_POLL_INTERVAL_MS: ${WORKER_POLL_INTERVAL_MS}
  WORKER_BATCH_SIZE: ${WORKER_BATCH_SIZE}
  WORKER_RESERVATION_TIMEOUT_MS: ${WORKER_RESERVATION_TIMEOUT_MS}
  WORKER_RETENTION_MS: ${WORKER_RETENTION_MS}
