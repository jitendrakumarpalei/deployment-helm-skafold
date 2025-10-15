runtime: nodejs22
service: default
entrypoint: npm start
automatic_scaling:
  max_instances: 3
  min_instances: 1
vpc_access_connector:
  name: ${VPC_CONNECTOR}
beta_settings:
  cloud_sql_instances: ${CLOUD_SQL_INSTANCE}
handlers:
  - url: /.*
    script: auto
    secure: always
env_variables:
  NODE_ENV: production
  DATABASE_URL: ${DATABASE_URL}
  META_LLM_CLASSIFIER_ENDPOINT: ${META_LLM_CLASSIFIER_ENDPOINT}
  META_LLM_API_KEY: ${META_LLM_API_KEY}
