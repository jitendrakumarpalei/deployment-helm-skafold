# Google App Engine (Flexible) Deployment

This configuration runs **all StringCost services inside a single App Engine flexible-service instance**. A PM2 “cloud” ecosystem supervises the four processes (gateway, control plane, event collector, worker) and keeps them within the same VM.

## Files

- `app.yaml` – App Engine flexible config (runtime `nodejs`, `env: flex`, entrypoint `npm run gae:start`). It forwards ports 8790/8791 for the internal services and exposes the gateway on port 8080.
- `../ecosystem.config.cjs` – Shared PM2 configuration used by both Render and GAE deployments. It binds:
  - Gateway → `process.env.PORT` (default 8080 on GAE)
  - Control plane → `CONTROL_PLANE_PORT` (defaults to 8790)
  - Event collector → `EVENT_COLLECTOR_PORT` (defaults to 8791)
  - Worker → background loop (no HTTP listener)

## Prerequisites

1. Enable App Engine flexible: `gcloud app create --region=<REGION>`
2. Provision backing services:
   - Cloud SQL (PostgreSQL); get a connection string or use the Cloud SQL Proxy.
   - Memorystore for Redis (or a compatible Redis service reachable from App Engine).
   - Meta-LLM classifier endpoint reachable over HTTPS.
3. Copy `service-account.json.example` to `service-account.json` (or provide a path via `SERVICE_ACCOUNT_JSON`) and paste your actual service account key contents. **Never commit the real key.** The deploy script will read `project_id` from this JSON unless you pass `--project` explicitly.
4. Update the placeholders in `app.yaml` with real URLs/tokens.

## Deploy

```bash
gcloud config set project YOUR_PROJECT_ID
npm run gae:deploy -- --project YOUR_PROJECT_ID
```

App Engine will:
1. Run `npm install --production`
2. Execute the `entrypoint` (`npm run gae:start`) which:
   - Builds all workspaces (`npm run build`)
   - Launches `pm2-runtime deploy/ecosystem.config.cjs`

The instance exposes:

- `https://<project>.appspot.com/llm/v1/*` → gateway
- Internal calls (control plane, event collector) run on `http://127.0.0.1:<PORT>` inside the VM; `CONTROL_PLANE_URL` is pre-set accordingly.

## Environment Variables

Edit `app.yaml` and substitute:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (use Cloud SQL Auth Proxy or private IP). |
| `REDIS_URL` | Redis connection string (Memorystore URI). |
| `META_LLM_CLASSIFIER_ENDPOINT` / `META_LLM_API_KEY` | URL + token for the classifier service. |
| `CLASSIFICATION_QUEUE_KEY` | Redis list key (defaults to `classification_jobs`). |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE` | Optional worker tuning knobs. |

Additional optional overrides:

- `CONTROL_PLANE_PORT`, `EVENT_COLLECTOR_PORT` – change the internal ports.
- `CONTROL_PLANE_URL`, `ALBUS_BASEPATH` – override the loopback URLs.
- `GATEWAY_PORT` – only if you must expose a different port (App Engine expects 8080).

## Local Dry Run

```bash
export DATABASE_URL=postgres://stringcost:stringcost@127.0.0.1:5432/stringcost
export REDIS_URL=redis://127.0.0.1:6379
export CONTROL_PLANE_PORT=8790
export EVENT_COLLECTOR_PORT=8791
npm install
npm run gae:start
```

PM2 Runtime will boot the four processes together. Use `pm2 logs` to inspect output, and `Ctrl+C` to stop. Ensure the same env vars you plan to use in production are present before running locally.
