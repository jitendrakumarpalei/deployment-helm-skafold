# Render Deployment Guide

This directory contains deployment assets for running **all StringCost services** on a single Render.com service via PM2.

## Build Command

Configure Render’s build step to compile every workspace:

```bash
npm install --no-audit --no-fund
npm run build
```

`npm run build` runs each workspace’s TypeScript build (`tsc`), generating the runtime files in `apps/*/dist`.

## Start Command

Use PM2 Runtime (distributed with npm via `npx`) to launch all services:

```bash
npm run deploy:start
```

This wraps `npx pm2-runtime deploy/ecosystem.config.cjs`, which starts:

1. **Control Plane** (`apps/control-plane/dist/server.js`)
2. **Gateway Wrapper** (`apps/gateway/dist/server.js`)
3. **Event Collector** (`apps/event-collector/dist/server.js`)
4. **Classification Worker** (`apps/worker/dist/worker.js`)

### Required Environment Variables

Set these in Render’s dashboard (values shown are local defaults):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `META_LLM_CLASSIFIER_ENDPOINT` | HTTP endpoint the worker calls for meta classification |
| `META_LLM_API_KEY` | Optional bearer token for the classifier service |
| `STRINGCOST_API_KEY` | Default API key issued to external clients (used by tests/demos) |
| `CONTROL_PLANE_URL` / `ALBUS_BASEPATH` | Override if the control-plane runs on a different host |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE`, `WORKER_RESERVATION_TIMEOUT_MS`, `WORKER_RETENTION_MS` | Tuning knobs for the worker loop |

Render automatically sets `PORT`; the gateway and other services use the values in `deploy/ecosystem.config.cjs`. Override `GATEWAY_PORT`, `CONTROL_PLANE_PORT`, or `EVENT_COLLECTOR_PORT` if you need custom ports inside the container.

## Local Dry Run

Before deploying, you can simulate the Render process locally (requires Docker/Postgres running somewhere reachable):

```bash
export DATABASE_URL=postgres://stringcost:stringcost@127.0.0.1:5432/stringcost
npm install
npm run build
npm run deploy:start
```

Use `pm2 status` / `pm2 logs` to inspect the processes. Press `Ctrl+C` to exit; PM2 Runtime will shut everything down gracefully.

## Google App Engine (Standard) Deployment

App Engine now runs as four services in the Standard environment (`default` gateway, `control-plane`, `event-collector`, `worker`) plus an optional `dispatch.yaml`. The deploy script renders the templates in `deploy/appengine/services/*.yaml.tpl` using variables from `deploy/appengine/.env`.

Deploy everything in one shot:

```bash
gcloud config set project <PROJECT_ID>
npm run gae:deploy
npm run gae:clean   # optional cleanup of dist/ + staged bundles
```

Before deploying, copy `deploy/appengine/service-account.json.example` to `deploy/appengine/service-account.json` (or set `SERVICE_ACCOUNT_JSON=/path/to/key.json`) **and** copy `deploy/appengine/.env.example` to `deploy/appengine/.env`. Fill in real values (Cloud SQL connection string, classifier URL/key, optional VPC connector, worker tuning). The deploy script activates the service account, renders the templates with those values, and deploys all services plus `dispatch.yaml`. See `deploy/appengine/README.md` for service-by-service details and local run commands.
