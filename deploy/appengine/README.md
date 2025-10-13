# Google App Engine (Standard) Deployment

StringCost now deploys as **four separate App Engine Standard services** (gateway, control plane, event collector, worker) plus a `dispatch.yaml` that routes custom domains. Each service boots its own Node.js 22 instance and runs a single Hono app; the gateway remains the only public endpoint.

## Files

- `services/gateway.yaml.tpl` – Template for the `/llm/v1/*` proxy (deployed as the `default` service)
- `services/control-plane.yaml.tpl` – Template for the config/model API
- `services/event-collector.yaml.tpl` – Template for the ledger ingestion API
- `services/worker.yaml.tpl` – Template for the classifier worker (basic scaling, single instance)
- `dispatch.yaml` – Optional domain routing (e.g., `api.stringcost.com`)
- `service-account.json.example` – Template for the deploy key consumed by `npm run gae:deploy`
- `.env.example` – Template for the configuration variables consumed by the deploy script

## Prerequisites

1. Enable App Engine Standard: `gcloud app create --region=<REGION>`
2. Provision backing services (Cloud SQL/PostgreSQL and the classifier endpoint).
3. Copy `deploy/appengine/service-account.json.example` to `deploy/appengine/service-account.json` (or point `SERVICE_ACCOUNT_JSON` at another path) and paste your real key. The deploy script reads `project_id` from this file automatically.
4. Copy `deploy/appengine/.env.example` to `deploy/appengine/.env` and fill in the environment variables (Cloud SQL socket connection string, classifier URL/key, worker tuning, optional `VPC_CONNECTOR`). If you plan to reach Cloud SQL over private IP, supply a Serverless VPC Access connector name (e.g., `projects/<PROJECT>/locations/<REGION>/connectors/<CONNECTOR>`). If you are using public IP connectivity or the Cloud SQL Auth Proxy, leave `VPC_CONNECTOR` empty and the generated YAMLs will skip the connector block.
5. Update `dispatch.yaml` to match your domain if you plan to expose the services publicly.

## Deploy

```bash
gcloud config set project <PROJECT_ID>
npm run gae:deploy
npm run gae:clean    # optional cleanup of dist/ and staged artifacts
```

`npm run gae:deploy` renders the service templates, builds the workspaces, activates the configured service account, and deploys all four service configs plus `dispatch.yaml` in a single gcloud invocation.

## Environment Variables

Each service YAML defines the variables it needs. Common ones:

| Variable | Service(s) | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | control-plane, event-collector, worker, gateway | PostgreSQL connection string (use Cloud SQL socket URL) |
| `CLOUD_SQL_INSTANCE` | gateway, control-plane, event-collector, worker | Cloud SQL instance name (`project:region:instance`) |
| `META_LLM_CLASSIFIER_ENDPOINT` / `META_LLM_API_KEY` | gateway, worker | External classifier endpoint & auth |
| `CONTROL_PLANE_URL`, `ALBUS_BASEPATH` | gateway | Leave empty to auto-resolve `https://control-plane-dot-<PROJECT_ID>.appspot.com` |

The worker service uses `basic_scaling` with a single instance; adjust `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE`, `WORKER_RESERVATION_TIMEOUT_MS`, or `WORKER_RETENTION_MS` if needed.

## Local Verification

You can run each service locally with the new scripts:

```bash
npm run gae:start:control-plane
npm run gae:start:event-collector
npm run gae:start:gateway
npm run gae:start:worker
```

Provide the same environment variables you plan to deploy (e.g., point `DATABASE_URL` at your Cloud SQL socket path). Stop each process with `Ctrl+C`.

## Cleanup

`npm run gae:clean` removes `apps/*/dist`, `vendor/portkey-gateway/build`, and any staged `app.yaml` so you can ship a clean source tree. Run it after deployment if you do not want compiled artifacts in your repository.
