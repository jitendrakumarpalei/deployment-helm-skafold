# StringCost Gateway & Billing Stack

This repository vendors the [Portkey](https://github.com/Portkey-AI/gateway) gateway and wraps it with the StringCost control plane, event collector, and billing ledger. The wrapper keeps Portkey unmodified while exposing brand-neutral APIs (`/llm/*`, `/control/*`, `/events/*`) and feeding usage data into our double-entry ledger.

- **Gateway** (`apps/gateway`) – Hono app that authenticates requests, fetches provider configuration from the control plane, normalises it into the Portkey format, then calls the vendored gateway in-process. All public endpoints live under `/llm/v1/*`.
- **Control Plane** (`apps/control-plane`) – Issues API keys, stores provider credentials/virtual keys, and advertises the model catalogue. Exposed under `/control/v1` and `/control/v2`.
- **Event Collector** (`apps/event-collector`) – Writes raw ledger events to Postgres and enqueues classification jobs in an `UNLOGGED` table (`classification_jobs`).
- **Worker** (`apps/worker`) – Background process that drains `classification_jobs`, calls the meta classifier, and updates `ledger_events`.
- **Vendored Portkey** (`vendor/portkey-gateway`) – Clean checkout of the upstream gateway. We keep the git metadata out of tree and pin the commit in `PORTKEY_TAG`.

> **Base URLs (production)**  
> Gateway: `https://api.stringcost.com/llm`  
> Control plane: `https://api.stringcost.com/control`  
> Event collector: `https://api.stringcost.com/events`

## Quick Start

### Prerequisites

- Node.js 20+
- Docker (used by tests via Testcontainers)
- PostgreSQL 16 (local or remote)

Clone dependencies and install packages:

```bash
git clone https://github.com/stringcost/stringcost.git
cd stringcost
npm install --no-audit --no-fund
```

### Environment

Copy `.env.example` (if present) or export variables manually. The minimum required set:

```bash
export DATABASE_URL="postgres://stringcost:stringcost@localhost:5432/stringcost?sslmode=disable"
export CONTROL_PLANE_URL="http://127.0.0.1:8787/control"
export GATEWAY_BASE_URL="http://127.0.0.1:8787"
export URL_TOKEN_KEY="$(openssl rand -base64 32)"
export META_LLM_CLASSIFIER_ENDPOINT="http://127.0.0.1:8890/classify"
export META_LLM_API_KEY="local-classifier"
export WORKER_POLL_INTERVAL_MS="200"

# Optional legacy variables (used when running the vendored Portkey UI/plugins)
export ALBUS_BASEPATH="$CONTROL_PLANE_URL"
```

### Run Database Migrations

```
# Ledger (billing, events, invoices)
npm run migrate --workspace @stringcost/ledger

# Control plane (clients, provider credentials, model catalogue)
node --loader ts-node/esm apps/control-plane/src/migrate.ts
```

Migrations default to `DATABASE_URL`. To use a different connection string, pass `--database-url=...`.

### Start the Services Locally

Each service is a small Hono app with a `dev` script:

```bash
# Terminal 1 – gateway wrapper (+ vendored Portkey)
npm run dev --workspace @stringcost/gateway

# Terminal 2 – control plane API
npm run dev --workspace @stringcost/control-plane

# Terminal 3 – event collector
npm run dev --workspace @stringcost/event-collector

# Terminal 4 – classification worker
npm run dev --workspace @stringcost/worker
```

By default the gateway listens on `http://127.0.0.1:8787`. Adjust `CONTROL_PLANE_URL`/`ALBUS_BASEPATH` if you bind the control-plane to another port.

### Run the Test Suite

Vitest relies on Testcontainers to spin up PostgreSQL automatically. Disable Ryuk in CI/WSL environments:

```bash
TESTCONTAINERS_RYUK_DISABLED=true npm test
```

To run only the ledger integrations (LangChain proxy + worker + migrations):

```bash
TESTCONTAINERS_RYUK_DISABLED=true npm run test:ledger
```

Supertest-based API suites (gateway and control plane) must bind to a local socket. Enable them by exporting `ENABLE_SUPERTEST=true` before running the respective workspace tests (CI jobs set this automatically; sandboxes without socket access will skip these suites).

## API Usage

Runtime requests no longer require custom headers. Instead, clients obtain a **one-use signed URL** from the control plane and then call that URL with the same headers they would send to the upstream provider (e.g., OpenAI or Anthropic). The signed URL encodes provider selection, virtual keys, run/user IDs, and optional extras (retry rules, metadata, body hash, etc.).

1. **Pre-sign** the target path using your StringCost API key (`Authorization: Bearer sk-stringcost-123`).
2. **Invoke** the returned URL with your normal provider headers (`Authorization: Bearer sk-openai-...`).
3. **(Optional)** Emit additional ledger events to `/events` for tool calls or custom steps.

### 1. Generate a signed URL

```bash
curl -X POST https://api.stringcost.com/control/v1/presign \
  -H "Authorization: Bearer sk-stringcost-123" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "openai",
        "method": "POST",
        "path": "/v1/chat/completions",
        "run_id": "6a9ab408-541f-40d3-af8a-5091c58cb89d",
        "user_id": "customer-4242",
        "metadata": {"tier": "gold"},
        "config": {
          "virtual_key": "vk-openai-prod",
          "retry": {"attempts": 3, "on_status_codes": [429] }
        },
        "expires_in": 60
      }'
```

**Response**

```json
{
  "url": "https://api.stringcost.com/llm/v1/chat/completions?token=eyes-only",
  "token": "eyes-only",
  "expires_at": 1736899200
}
```

### 2. Call the gateway using the signed URL

```bash
curl "https://api.stringcost.com/llm/v1/chat/completions?token=eyes-only" \
  -H "Authorization: Bearer sk-openai-real" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-4o-mini",
        "messages": [
          { "role": "user", "content": "Summarise the Q3 release plan in 5 bullet points." }
        ]
      }'
```

Any OpenAI-compatible SDK can implement this flow by calling `/control/v1/presign` per request and then forwarding the request to the returned URL. The `tests/langchain/proxy.test.ts` fixture demonstrates a LangChain adapter that does exactly this.

### 3. Log Explicit Events (Optional)

The gateway already writes a raw event and enqueues a classification job for every request. If your agent performs additional work (tool executions, external API calls) you can log them explicitly:

```bash
curl https://api.stringcost.com/events \
  -H "Content-Type: application/json" \
  -d '{
        "run_id": "6a9ab408-541f-40d3-af8a-5091c58cb89d",
        "user_id": "customer-4242",
        "step_name": "fetch-weather",
        "action_type": "tool_selection",
        "outcome": "success",
        "duration_ms": 830,
        "cost_cogs_micros": 110,
        "revenue_billed_micros": 1450,
        "prompt_content": "Weather API call payload..."
      }'
```

The event collector inserts the record into `ledger_events` and enqueues the prompt for meta-classification. The worker updates `action_type` once the classifier responds.

## Presign Request Fields

| Field | Purpose |
| --- | --- |
| `provider` | Which stored credential to use (`openai`, `anthropic`, `groq`, …). Optional if you supply `virtual_key`. |
| `virtual_key` | Explicit credential key to use (overrides `provider` default). |
| `method` | HTTP verb to lock the signed URL to (`POST`, `GET`, …). Defaults to `POST`. |
| `path` | Target path relative to `/llm` (e.g., `/v1/chat/completions`). |
| `config` | Optional Portkey configuration overrides (targets, retry policy, guardrails, cache, etc.). The control plane injects the real `api_key` before sealing the token. |
| `run_id`, `user_id` | Embedded into the token so ledger events and metrics map back to your agent/session. |
| `metadata` | Arbitrary JSON persisted alongside the ledger entry. |
| `body_sha256` | Optional hex digest to bind the token to an exact request payload. |
| `expires_in` | Time-to-live for the URL in seconds (defaults to `60`, max `600`). |

The control plane encrypts the payload with AES-256-GCM using `URL_TOKEN_KEY`. The gateway decrypts it, validates method/path/expiry, injects internal `x-portkey-*` headers, and then hands the request to the vendored gateway.

## Operational Notes

- **PostgreSQL cache for classification** – We use an `UNLOGGED` table to avoid Redis; jobs are lightweight and truncated automatically if the database restarts.
- **Portkey updates** – To bump the vendored gateway, replace `vendor/portkey-gateway` with a fresh checkout and update `PORTKEY_TAG`.
- **Google App Engine deployment** – `deploy/appengine/deploy.sh` renders per-service YAML, stages dist builds, and deploys with `--promote`. Set `TESTCONTAINERS_RYUK_DISABLED=true` in CI to keep tests green.
- **Troubleshooting** – Enable verbose logging by exporting `DEBUG_GATEWAY_CONFIG=1`, `DEBUG_GATEWAY_FORWARD=1`, or `DEBUG_CONTROL_PLANE=1` before starting the services.

## Useful Commands

```bash
# Build all packages
npm run build

# Run only gateway tests
npm run test --workspace @stringcost/gateway

# Lint Portkey schema (vendored tests are skipped by default)
npm run test --workspace @portkey-ai/gateway

# Clean staged App Engine artifacts
npm run gae:clean
```

When adding new migrations, follow the millisecond timestamp naming pattern (e.g., `1738368000000_new_feature.cjs`) so `node-pg-migrate` recognises file order without logging warnings.
