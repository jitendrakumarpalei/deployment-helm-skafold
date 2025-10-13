const path = require('node:path');

const rootDir = __dirname;
const resolveDist = (service, file) =>
  path.join(rootDir, '..', 'apps', service, 'dist', file);

const GATEWAY_PORT =
  process.env.PORT ?? process.env.GATEWAY_PORT ?? '8787';
const CONTROL_PLANE_PORT = process.env.CONTROL_PLANE_PORT ?? '8789';
const EVENT_COLLECTOR_PORT = process.env.EVENT_COLLECTOR_PORT ?? '8790';

const sharedEnv = {
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgres://stringcost:stringcost@127.0.0.1:5432/stringcost',
};

module.exports = {
  apps: [
    {
      name: 'stringcost-control-plane',
      script: 'node',
      args: resolveDist('control-plane', 'server.js'),
      cwd: path.join(rootDir, '..'),
      env: {
        ...sharedEnv,
        PORT: CONTROL_PLANE_PORT,
      },
    },
    {
      name: 'stringcost-gateway',
      script: 'node',
      args: resolveDist('gateway', 'server.js'),
      cwd: path.join(rootDir, '..'),
      env: {
        ...sharedEnv,
        PORT: GATEWAY_PORT,
        CONTROL_PLANE_URL:
          process.env.CONTROL_PLANE_URL ??
          `http://127.0.0.1:${CONTROL_PLANE_PORT}`,
        ALBUS_BASEPATH:
          process.env.ALBUS_BASEPATH ??
          `http://127.0.0.1:${CONTROL_PLANE_PORT}`,
      },
    },
    {
      name: 'stringcost-event-collector',
      script: 'node',
      args: resolveDist('event-collector', 'server.js'),
      cwd: path.join(rootDir, '..'),
      env: {
        ...sharedEnv,
        PORT: EVENT_COLLECTOR_PORT,
      },
    },
    {
      name: 'stringcost-worker',
      script: 'node',
      args: resolveDist('worker', 'worker.js'),
      cwd: path.join(rootDir, '..'),
      env: {
        ...sharedEnv,
        META_LLM_CLASSIFIER_ENDPOINT:
          process.env.META_LLM_CLASSIFIER_ENDPOINT ??
          'http://127.0.0.1:8791/classify',
        META_LLM_API_KEY: process.env.META_LLM_API_KEY ?? 'classifier-key',
        WORKER_POLL_INTERVAL_MS:
          process.env.WORKER_POLL_INTERVAL_MS ?? '500',
        WORKER_BATCH_SIZE: process.env.WORKER_BATCH_SIZE ?? '5',
      },
    },
  ],
};
