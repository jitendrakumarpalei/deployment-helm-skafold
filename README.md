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
export ALBUS_BASEPATH="$CONTROL_PLANE_URL"          # used internally by Portkey
export META_LLM_CLASSIFIER_ENDPOINT="http://127.0.0.1:8890/classify"
export META_LLM_API_KEY="local-classifier"
export WORKER_POLL_INTERVAL_MS="200"
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

## API Usage

The public interface mirrors OpenAI’s REST API but requires StringCost headers. A typical flow:

1. Call the control plane to resolve provider configuration (virtual key, metadata).
2. Send your LLM request to `/llm/v1/...` with `Authorization` and `x-stringcost-*` headers.
3. Optionally POST usage events to `/events` if you have out-of-band work to log.

### 1. Resolve Provider Configuration

```bash
curl https://api.stringcost.com/control/v1/account/config \
  -H "Authorization: Bearer sk-stringcost-123" \
  -H "Content-Type: application/json"

# With provider filter:
curl "https://api.stringcost.com/control/v1/account/config?provider=openai" \
  -H "Authorization: Bearer sk-stringcost-123"
```

**Response**

```json
{
  "provider": "openai",
  "config": {
    "provider": "openai",
    "virtual_key": "vk-openai-prod",
    "config": {
      "api_key": "sk-openai-real"
    },
    "metadata": { "tier": "enterprise" }
  }
}
```

Use the returned `provider` and `virtual_key` (or `config.api_key`) in the next request.

### 2. Call the Gateway

```bash
curl https://api.stringcost.com/llm/v1/chat/completions \
  -H "Authorization: Bearer sk-stringcost-123" \
  -H "Content-Type: application/json" \
  -H "x-stringcost-provider: openai" \
  -H "x-stringcost-config: {\"virtual_key\":\"vk-openai-prod\"}" \
  -H "x-stringcost-run-id: 6a9ab408-541f-40d3-af8a-5091c58cb89d" \
  -H "x-stringcost-user-id: customer-4242" \
  -d '{
        "model": "gpt-4o-mini",
        "messages": [
          { "role": "user", "content": "Summarise the Q3 release plan in 5 bullet points." }
        ]
      }'
```

Any OpenAI-compatible SDK can hit the same endpoints by pointing its `baseURL` to `https://api.stringcost.com/llm/v1`. Example with the official OpenAI JS SDK:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'unused-when-virtual-key-present',
  baseURL: 'https://api.stringcost.com/llm/v1',
  defaultHeaders: {
    Authorization: 'Bearer sk-stringcost-123',
    'x-stringcost-provider': 'anthropic',
    'x-stringcost-config': JSON.stringify({ virtual_key: 'vk-anthropic-prod' }),
    'x-stringcost-run-id': crypto.randomUUID(),
    'x-stringcost-user-id': 'workspace-17'
  }
});

const completion = await client.chat.completions.create({
  model: 'claude-3-sonnet-20240229',
  messages: [{ role: 'user', content: 'Draft a SOC2 compliant password policy.' }]
});
```

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

## Header Reference

| Header | Purpose |
| --- | --- |
| `Authorization: Bearer <StringCost API key>` | Authenticates the workspace. Required for control plane + gateway. |
| `x-stringcost-provider` | Provider name used by the wrapper and for control-plane lookups (e.g., `openai`, `anthropic`, `groq`). |
| `x-stringcost-config` | JSON configuration mirroring Portkey’s config schema. Supply `virtual_key`, `targets`, `retry`, `guardrails`, etc. |
| `x-stringcost-run-id` | UUID for the agent run; groups ledger rows. |
| `x-stringcost-user-id` | Downstream customer/user identifier. |
| `x-stringcost-metadata` | JSON string persisted with the ledger record. |
| `x-stringcost-forward-headers` | Comma-separated list of headers to forward to the provider. |
| `x-stringcost-request-timeout` | Upstream provider timeout in milliseconds. |
| `x-stringcost-strict-openai-compliance` | `true` to coerce responses into the OpenAI schema for non-OpenAI providers. |

Internally the wrapper translates `x-stringcost-*` to the vendored `x-portkey-*` headers so no Portkey branding appears in the public surface area.

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
