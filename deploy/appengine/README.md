# Google App Engine (Standard) Deployment

StringCost now deploys as **four separate App Engine Standard services** (gateway, control plane, event collector, worker) plus a `dispatch.yaml` that routes custom domains. Each service boots its own Node.js 22 instance and runs a single Hono app; the gateway remains the only public endpoint.

## Files

- `services/gateway.yaml` – External `/llm/v1/*` proxy
- `services/control-plane.yaml` – Internal config & model catalog API
- `services/event-collector.yaml` – Ledger ingestion & classification queue producer
- `services/worker.yaml` – Background classifier loop (basic scaling, single instance)
- `dispatch.yaml` – Optional domain routing (e.g., `api.stringcost.com`)
- `service-account.json.example` – Template for the deploy key consumed by `npm run gae:deploy`

## Prerequisites

1. Enable App Engine Standard: `gcloud app create --region=<REGION>`
2. Provision backing services (Cloud SQL/PostgreSQL, Memorystore/Redis, classifier endpoint).
3. Copy `deploy/appengine/service-account.json.example` to `deploy/appengine/service-account.json` (or point `SERVICE_ACCOUNT_JSON` at another path) and paste your real key. The deploy script reads `project_id` from this file automatically.
4. Edit each YAML in `deploy/appengine/services/` and replace the placeholder environment variable values (Postgres URL, Redis URL, classifier endpoint/key, etc.).
5. Update `dispatch.yaml` to match your domain if you plan to expose the services publicly.

## Deploy

```bash
gcloud config set project <PROJECT_ID>
npm run gae:deploy
npm run gae:clean    # optional cleanup of dist/ and staged artifacts
```

`npm run gae:deploy` builds the workspaces, activates the configured service account, and deploys all four service configs plus `dispatch.yaml` in a single gcloud invocation.

## Environment Variables

Each service YAML defines the variables it needs. Common ones:

| Variable | Service(s) | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | control-plane, event-collector, worker, gateway | PostgreSQL connection string |
| `REDIS_URL` | gateway, event-collector, worker | Redis/queue connection |
| `CLASSIFICATION_QUEUE_KEY` | gateway, event-collector, worker | Redis list name (default `classification_jobs`) |
| `META_LLM_CLASSIFIER_ENDPOINT` / `META_LLM_API_KEY` | gateway, worker | External classifier endpoint & auth |
| `CONTROL_PLANE_URL`, `ALBUS_BASEPATH` | gateway | Leave empty to auto-resolve `https://control-plane-dot-<PROJECT_ID>.appspot.com` |

The worker service uses `basic_scaling` with a single instance; adjust `WORKER_POLL_INTERVAL_MS` or `WORKER_BATCH_SIZE` if needed.

## Local Verification

You can run each service locally with the new scripts:

```bash
npm run gae:start:control-plane
npm run gae:start:event-collector
npm run gae:start:gateway
npm run gae:start:worker
```

Provide the same environment variables you plan to deploy (e.g., point `DATABASE_URL` and `REDIS_URL` at local instances). Stop each process with `Ctrl+C`.

## Cleanup

`npm run gae:clean` removes `apps/*/dist`, `vendor/portkey-gateway/build`, and any staged `app.yaml` so you can ship a clean source tree. Run it after deployment if you do not want compiled artifacts in your repository.
