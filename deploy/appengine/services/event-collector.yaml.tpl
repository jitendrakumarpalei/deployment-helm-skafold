runtime: nodejs22
service: event-collector
entrypoint: npm run gae:start:event-collector
automatic_scaling:
  max_instances: 2
  min_instances: 1
vpc_access_connector:
  name: ${VPC_CONNECTOR}
beta_settings:
  cloud_sql_instances: ${CLOUD_SQL_INSTANCE}
env_variables:
  NODE_ENV: production
  DATABASE_URL: ${DATABASE_URL}
