# StringCost Gateway & Billing Stack

## 🏗️ Architecture Overview

```mermaid
graph TB
    subgraph "Client Layer"
        Client[Client Application<br/>LangChain/OpenAI SDK]
    end

    subgraph "External Services"
        OpenAI[OpenAI API]
        Anthropic[Anthropic API]
        Other[Other LLM Providers]
    end

    subgraph "GKE Cluster / Cloud Run"
        subgraph "Gateway Service :8787"
            Gateway[Gateway<br/>apps/gateway<br/>Rate Limited]
            Portkey[Vendored Portkey<br/>vendor/portkey-gateway<br/>In-Process]
            ReplayStore[(Replay Store<br/>signed_url_replays)]
        end

        subgraph "Control Plane :8788"
            ControlPlane[Control Plane<br/>apps/control-plane<br/>Rate Limited]
            CredStore[(Credentials DB<br/>provider_credentials<br/>api_clients)]
        end

        subgraph "Event Collector :8789"
            EventCollector[Event Collector<br/>apps/event-collector<br/>Rate Limited]
            ClassQueue[(Classification Queue<br/>classification_jobs<br/>UNLOGGED)]
        end

        subgraph "Background Worker"
            Worker[Worker<br/>apps/worker<br/>Poll Every 200ms]
            Classifier[Meta Classifier API]
        end

        subgraph "Shared Database"
            Postgres[(PostgreSQL 16<br/>Ledger + Control + Replays)]
        end
    end

    %% Client Flow
    Client -->|1. POST /control/v1/presign<br/>Bearer sk-stringcost-xxx| ControlPlane
    ControlPlane -->|Read credentials| CredStore
    ControlPlane -->|Read/verify client| CredStore
    ControlPlane -.->|2. Return signed URL<br/>+ encrypted config| Client

    Client -->|3. POST signed URL<br/>Bearer sk-openai-xxx| Gateway
    Gateway -->|Verify signature<br/>Check replay| ReplayStore
    Gateway -->|Decrypt config<br/>Forward request| Portkey

    Portkey -->|Proxy to provider| OpenAI
    Portkey -->|Proxy to provider| Anthropic
    Portkey -->|Proxy to provider| Other

    Portkey -.->|Provider response| Gateway
    Gateway -.->|4. Return response| Client
    Gateway -->|5. POST /events<br/>Write ledger event| EventCollector

    %% Event Processing
    EventCollector -->|Insert event| Postgres
    EventCollector -->|Enqueue job| ClassQueue

    Worker -->|Poll queue| ClassQueue
    Worker -->|Classify prompt| Classifier
    Classifier -.->|action_type| Worker
    Worker -->|Update event| Postgres

    %% Database connections
    CredStore -.-> Postgres
    ReplayStore -.-> Postgres
    ClassQueue -.-> Postgres

    %% Styling
    classDef clientStyle fill:#e1f5ff,stroke:#01579b,stroke-width:2px
    classDef serviceStyle fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef dbStyle fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef externalStyle fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef workerStyle fill:#fce4ec,stroke:#880e4f,stroke-width:2px

    class Client clientStyle
    class Gateway,ControlPlane,EventCollector,Portkey serviceStyle
    class Postgres,CredStore,ReplayStore,ClassQueue dbStyle
    class OpenAI,Anthropic,Other,Classifier externalStyle
    class Worker workerStyle
```

## 📋 Service Summary

This repository vendors the [Portkey](https://github.com/Portkey-AI/gateway) gateway and wraps it with the StringCost control plane, event collector, and billing ledger. The wrapper keeps Portkey unmodified while exposing brand-neutral APIs (`/llm/*`, `/control/*`, `/events/*`) and feeding usage data into our double-entry ledger.

- **Gateway** (`apps/gateway`) – Hono app that authenticates requests, fetches provider configuration from the control plane, normalises it into the Portkey format, then calls the vendored gateway in-process. All public endpoints live under `/llm/v1/*`.
- **Control Plane** (`apps/control-plane`) – Issues API keys, stores provider credentials/virtual keys, and advertises the model catalogue. Exposed under `/control/v1` and `/control/v2`.
- **Event Collector** (`apps/event-collector`) – Writes raw ledger events to Postgres and enqueues classification jobs in an `UNLOGGED` table (`classification_jobs`).
- **Worker** (`apps/worker`) – Background process that drains `classification_jobs`, calls the meta classifier, and updates `ledger_events`.
- **Vendored Portkey** (`vendor/portkey-gateway`) – Clean checkout of the upstream gateway. We keep the git metadata out of tree and pin the commit in `PORTKEY_TAG`.

### 🚀 Portkey Integration Benefits

StringCost leverages **Portkey's AI gateway** to provide:

- **250+ LLM providers** with unified OpenAI-compatible API (Google Gemini, Anthropic, Cohere, Azure, etc.)
- **Automatic request transformation** – Use OpenAI format for all providers; Portkey handles the translation
- **Built-in reliability** – Retries, fallbacks, load balancing, timeouts
- **Advanced features**:
  - Semantic caching for faster responses
  - Guardrails for content filtering
  - Real-time streaming
  - Multimodal support (images, audio, video)
- **Provider-specific capabilities**:
  - **Gemini**: System prompt transformation, Google Search grounding, extended thinking mode
  - **Anthropic**: Prompt caching, tool use
  - **OpenAI**: Function calling, vision, audio

All of this is available through StringCost's unified presign + signed URL flow with built-in cost tracking and billing.

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
export URL_TOKEN_KEYS="primary:$(openssl rand -base64 32)"
export URL_TOKEN_CONFIG_KEY="$(openssl rand -base64 32)"
export META_LLM_CLASSIFIER_ENDPOINT="http://127.0.0.1:8890/classify"
export META_LLM_API_KEY="local-classifier"
export WORKER_POLL_INTERVAL_MS="200"

# Optional: override replay store and canonical host configuration
export SIGNED_URL_DATABASE_URL="$DATABASE_URL"

# Optional legacy variables (used when running the vendored Portkey UI/plugins)
export ALBUS_BASEPATH="$CONTROL_PLANE_URL"
```

### Run Database Migrations

```
# Apply migrations for both databases
DATABASE_URL=postgres://stringcost:stringcost@localhost:5432/stringcost npm run db:migrate

# (Optional) Run seed scripts (loads demo client, credentials, billing data)
DATABASE_URL=postgres://stringcost:stringcost@localhost:5432/stringcost npm run db:seed
```

The seed scripts create a demo API client with OpenAI/Anthropic virtual keys and sample ledger data so sandbox calls work out of the box.

You can target individual services via `npm run migrate:control-plane` or `npm run migrate:ledger`. All scripts respect the `DATABASE_URL` environment variable.

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

### Build Smoke Tests

Before deploying or building Docker images, run smoke tests to verify all services build and start correctly:

```bash
# CI-style build test (no Docker, mimics exact Docker build steps)
npm run smoke-test

# Docker build test (builds all 4 service images and tests startup)
npm run docker:smoke-test
```

The CI-style smoke test:
- Creates a temporary workspace and copies project files
- Installs dependencies (including portkey-gateway for gateway service)
- Builds all workspaces in the correct order
- Verifies built artifacts exist
- Tests that each service can load without crashes

This is especially useful in CI pipelines to catch build issues before Docker image creation.

To run only the ledger integrations (LangChain proxy + worker + migrations):

```bash
TESTCONTAINERS_RYUK_DISABLED=true npm run test:ledger
```

Supertest-based API suites (gateway and control plane) must bind to a local socket. Enable them by exporting `ENABLE_SUPERTEST=true` before running the respective workspace tests (CI jobs set this automatically; sandboxes without socket access will skip these suites).

## Deploy to GKE (Laptop → Production Workflow)

**✅ Uses Helm + Skaffold** - Deploy directly from your laptop—no GitOps required.

The deployment uses:
- **Helm** for Kubernetes manifests (clean, parameterized YAML)
- **Skaffold** for building images via Google Cloud Build
- **Terraform** for GKE cluster provisioning
- **Local deployment** from your laptop (no CI/CD needed)

**📖 See [deploy/gke/DEPLOYMENT.md](deploy/gke/DEPLOYMENT.md) for complete step-by-step guide.**

Quick start:

### Required credentials & permissions

1. **Personal (interactive) account** – the user running Terraform must set the active project and authenticate:
   ```bash
   gcloud config set project <YOUR_PROJECT_ID>
   gcloud auth login                     # optional but recommended
   gcloud auth application-default login # required for Terraform
   ```
   The account needs the ability to enable services and create IAM bindings/networks on the target project. Practically this means either `roles/owner` or a custom combination that includes at least:
   - `roles/serviceusage.serviceUsageAdmin` (enable APIs)
   - `roles/resourcemanager.projectIamAdmin` (grant IAM roles to the deployer SA)
   - `roles/container.admin` / `roles/container.clusterAdmin` (create clusters)
   - `roles/compute.networkAdmin` (reserve global IPs)

2. **Deployer service account** – Terraform creates `gke-deployer` with the minimal roles needed for CLI deployments (`roles/container.developer`, `roles/storage.admin`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer`, `roles/compute.viewer`). The associated JSON key is written to `deploy/gke/gke-deployer-key.json`; treat it like a secret (never commit it, rotate if leaked).

3. **Local tools** – install `terraform`, `gcloud`, `kubectl`, `skaffold`, and `helm`. When Terraform finishes, it leaves the generated key on disk and you can use it immediately via the deployment script. If you run deployments in CI, store the key (or regenerate it) in the pipeline’s secret store.

### 1. One-time setup

```bash
cd deploy/gke/terraform
terraform init
terraform apply                           # enables APIs, creates cluster(s), reserves static IP

# Point your DNS A record at the emitted static IP before continuing

# (Optional) expose outputs as env vars for the deploy script
export CLUSTER_NAME="$(terraform -chdir=terraform output -raw cluster_name)"
export DEV_CLUSTER_NAME="$(terraform -chdir=terraform output -raw dev_cluster_name 2>/dev/null || true)"
export PROD_CLUSTER_NAME="$(terraform -chdir=terraform output -raw prod_cluster_name 2>/dev/null || true)"
export REGION="${REGION:-us-central1}"
```

Create Kubernetes secrets with all required keys:

```bash
# Generate encryption keys
export DATABASE_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export URL_TOKEN_KEYS="primary:$(openssl rand -base64 32),secondary:$(openssl rand -base64 32)"

# Create secret
kubectl create secret generic stringcost-config \
  --from-literal=database_url="postgresql://user:pass@host:5432/stringcost" \
  --from-literal=database_encryption_key="${DATABASE_ENCRYPTION_KEY}" \
  --from-literal=url_token_keys="${URL_TOKEN_KEYS}" \
  --from-literal=classifier_endpoint="https://classifier.com/v1/classify" \
  --from-literal=classifier_api_key="your-api-key"
```

**Required secret keys:**
- `database_url` - PostgreSQL connection string
- `database_encryption_key` - For encrypting client-provided API keys
- `url_token_keys` - HMAC keys for signing URLs (supports rotation)
- `classifier_endpoint` - Meta classifier API endpoint
- `classifier_api_key` - Classifier API key

### 2. Deploy from your laptop

```bash
# Deploy to default cluster
npm run gke:deploy

# Or deploy to specific environment
npm run gke:deploy:dev   # dev cluster
npm run gke:deploy:prod  # prod cluster
```

This runs Skaffold which:
1. ✅ Builds Docker images via **Google Cloud Build** (not local)
2. ✅ Pushes to GCR/Artifact Registry
3. ✅ Deploys Helm chart with all 4 services
4. ✅ Configures Ingress + TLS certificate

**No local Docker builds** - all images are built in Cloud Build for consistency.

## API Usage

Runtime requests no longer require custom headers. Instead, clients obtain a **one-use signed URL** from the control plane and then call that URL with the same headers they would send to the upstream provider (e.g., Gemini, OpenAI, or Anthropic). The signed URL encodes provider selection, API keys, run/user IDs, and optional extras (retry rules, metadata, body hash, etc.).

**Two modes supported:**
1. **Client-provided API keys** – Pass your own provider API key (e.g., Gemini API key) at presign time, stored temporarily with automatic expiration
2. **Pre-configured credentials** – Use virtual keys stored in the control plane database

### Example: Using Google Gemini with Client-Provided API Key

This is the recommended approach for getting started - your API key is stored temporarily (default 1 hour, max 24 hours) and auto-deleted using pg_cron.

**Important:** Portkey (the underlying router) uses provider name `"google"` for Gemini and provides OpenAI-compatible endpoints. You use OpenAI's chat completions format, and Portkey automatically transforms requests/responses for Gemini's API.

#### 1. Generate a signed URL with your Gemini API key

```bash
curl -X POST https://api.stringcost.com/control/v1/presign \
  -H "Authorization: Bearer sk-stringcost-demo" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "google",
        "method": "POST",
        "path": "/v1/chat/completions",
        "client_api_key": "AIzaSy...your-actual-gemini-key",
        "client_key_ttl": 3600,
        "run_id": "6a9ab408-541f-40d3-af8a-5091c58cb89d",
        "user_id": "customer-4242",
        "metadata": {"tier": "gold"},
        "config": {
          "model": "gemini-1.5-flash"
        },
        "expires_in": 45
      }'
```

**Key parameters:**
- `provider` – Use `"google"` for Gemini (Portkey's provider name)
- `path` – Use OpenAI-compatible path `/v1/chat/completions`
- `client_api_key` – Your Gemini API key from Google AI Studio (stored encrypted, auto-deleted after TTL)
- `client_key_ttl` – How long to store the key in seconds (60-86400, default: 3600)
- `config.model` – Gemini model name (e.g., `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.0-flash-thinking-exp`)

### Alternative: Using Pre-Configured Credentials

If you've stored credentials in the control plane database, use virtual keys:

```bash
curl -X POST https://api.stringcost.com/control/v1/presign \
  -H "Authorization: Bearer sk-stringcost-demo" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "google",
        "method": "POST",
        "path": "/v1/chat/completions",
        "virtual_key": "vk-gemini-demo",
        "run_id": "6a9ab408-541f-40d3-af8a-5091c58cb89d",
        "user_id": "customer-4242",
        "metadata": {"tier": "gold"},
        "config": {
          "model": "gemini-1.5-flash",
          "retry": {"attempts": 3, "on_status_codes": [429] }
        },
        "expires_in": 45
      }'
```

**Response**

```json
{
  "url": "https://api.stringcost.com/llm/v1/chat/completions?kid=primary&client=...&provider=openai&method=POST&host=api.stringcost.com&path=/v1/chat/completions&exp=1731619200&nonce=0b0849d0-...&session=018f1d5f-8aa5-7c93-a44a-53f97b07c1d3&cfg=...&cfg_h=...&sig=...",
  "session_id": "018f1d5f-8aa5-7c93-a44a-53f97b07c1d3",
  "nonce": "0b0849d0-49b9-4a76-8f14-0b2d5b7bf7de",
  "expires_at": 1731619200,
  "kid": "primary"
}
```

The query string carries everything the gateway needs to authenticate and route the request:

| Param | Description |
| --- | --- |
| `kid` | Signing key identifier used to verify the HMAC. |
| `client` | StringCost client ID associated with the API key. |
| `provider` | Upstream provider (`openai`, `anthropic`, …). |
| `method` | HTTP verb locked into the pre-signed request. |
| `host` | Expected gateway host; compared (hostname + optional port) to the actual request. |
| `path` | Canonical provider path (without the `/llm` prefix). |
| `exp` | Expiry timestamp (epoch seconds). Default 60s, configurable via `expires_in` (capped at 600s). |
| `nonce` + `session` | UUID values used for replay detection (one-time use). |
| `body` | Optional lowercase hex SHA-256 hash that must match the request body. |
| `cfg` / `cfg_h` | AES-GCM encrypted provider config (API keys, virtual key) and its hash. |
| `run`, `user`, `scope`, `meta` | Optional tracing metadata propagated to the ledger. |
| `sig` | Base64url HMAC-SHA256 over the canonical request string. |

Canonical string (used for signature verification):

```
METHOD\nHOST\nPATH\nBODY_HASH\nEXP\nNONCE\nSESSION\nCLIENT\nPROVIDER\nSCOPE\nCFG_HASH\nRUN_ID\nUSER_ID\nMETADATA_HASH
```

#### 2. Call the gateway using the signed URL

```bash
curl "https://api.stringcost.com/llm/v1/chat/completions?kid=...&client=...&...&sig=..." \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gemini-1.5-flash",
        "messages": [
          {"role": "user", "content": "Explain how AI works in 3 bullet points"}
        ]
      }'
```

**Note:** Use OpenAI's chat completions format - Portkey automatically transforms this to Gemini's native format. The API key is already embedded in the signed URL (from the `client_api_key` or `virtual_key` you provided at presign time).

**Portkey's Gemini capabilities:**
- ✅ Automatic system prompt transformation for Gemini compatibility
- ✅ Google Search grounding with `"google_search"` tool
- ✅ Multimodal support (images, audio, video, documents)
- ✅ Streaming responses
- ✅ Extended thinking mode (`gemini-2.0-flash-thinking-exp`)

### Example: Using OpenAI

For OpenAI, the flow is similar:

```bash
curl "https://api.stringcost.com/llm/v1/chat/completions?kid=...&client=...&...&sig=..." \
  -H "Authorization: Bearer sk-openai-demo" \
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

### Client-Provided API Key Storage & Security

When using `client_api_key`, StringCost stores your provider API key temporarily in PostgreSQL with these safeguards:

- **Encryption at rest:** Keys are encrypted using pgcrypto (`pgp_sym_encrypt`) with `DATABASE_ENCRYPTION_KEY`
- **Automatic deletion:** pg_cron deletes expired keys hourly (requires `CREATE EXTENSION pg_cron`)
- **Configurable TTL:** Set `client_key_ttl` (60-86400 seconds, default: 3600)
- **Per-client isolation:** Keys are scoped to your `api_client_id` and cannot be accessed by others

**Setup pg_cron for automatic cleanup:**

```sql
-- Requires superuser or pg_cron permissions
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Verify the cleanup job is scheduled
SELECT * FROM cron.job WHERE jobname = 'cleanup-expired-client-api-keys';
```

If pg_cron is unavailable, set up a manual cleanup cron job:

```bash
# Run every hour
0 * * * * psql $DATABASE_URL -c "DELETE FROM client_api_keys WHERE expires_at < NOW()"
```

**Environment variables:**

- `DATABASE_ENCRYPTION_KEY` – 32-byte key for encrypting client API keys (required for production)

### Signed URL Security Notes

- **Key management:** Configure `URL_TOKEN_KEYS="kid1:base64key,kid2:base64key"` (32-byte HMAC keys). Optionally set `URL_TOKEN_PRIMARY_KID` to select the active signing key.
- **Config encryption:** `URL_TOKEN_CONFIG_KEY` supplies the AES-256-GCM key that encrypts provider secrets inside the `cfg` parameter (falls back to the primary signing key when omitted).
- **Replay protection:** The gateway stores `(session_id, nonce)` pairs in `signed_url_replays`. Point `SIGNED_URL_DATABASE_URL` at PostgreSQL (defaults to `DATABASE_URL`). If unreachable, an in-memory fallback enforces best-effort protection.
- **TTL bounds:** `SIGNED_URL_DEFAULT_TTL` (60s) and `SIGNED_URL_MAX_TTL` (600s) clamp the allowed `expires_in` value.
- **Body integrity:** Include `body_sha256` when the payload is known in advance. The gateway recomputes the hash and rejects mismatches.
- **Traceability:** Optional `run_id`, `user_id`, `scope`, and structured `metadata` flow through the token and into the ledger with the signature covering their values.
- **Testing:** Supertest suites for the control-plane and gateway require socket binds. Set `ENABLE_SUPERTEST=true` before running the workspace tests (CI already does this).

## Presign Request Fields

| Field | Purpose |
| --- | --- |
| `provider` | Portkey provider name (`google` for Gemini, `openai`, `anthropic`, `groq`, …). Required when using `client_api_key`. Optional with `virtual_key`. See [Portkey docs](https://portkey.ai/docs/integrations/llms) for all providers. |
| `virtual_key` | Explicit credential key stored in database (overrides `provider` default). Cannot be used with `client_api_key`. |
| `client_api_key` | Your provider API key (stored encrypted temporarily). Use this for quick setup without pre-configuring credentials. |
| `client_key_ttl` | How long to store `client_api_key` in seconds (60-86400, default: 3600). Keys auto-delete via pg_cron. |
| `method` | HTTP verb to lock the signed URL to (`POST`, `GET`, …). Defaults to `POST`. |
| `path` | Target path relative to `/llm` (e.g., `/v1/chat/completions`, `/v1beta/models/gemini-1.5-flash:generateContent`). |
| `config` | Optional Portkey configuration overrides (targets, retry policy, guardrails, cache, etc.). The control plane injects the real `api_key` before sealing the token. |
| `run_id`, `user_id` | Embedded into the token so ledger events and metrics map back to your agent/session. |
| `metadata` | Arbitrary JSON persisted alongside the ledger entry. |
| `body_sha256` | Optional hex digest to bind the token to an exact request payload. |
| `expires_in` | Time-to-live for the URL in seconds (defaults to `60`, max `600`). |

The control plane signs a canonical request string with HMAC-SHA256 (using the key identified by `kid`) and encrypts the provider configuration with AES-256-GCM (`URL_TOKEN_CONFIG_KEY`). The gateway validates the signature, enforces method/path/body/host scoping, records the `(session, nonce)` pair, decrypts the config, and forwards the call to the vendored Portkey router with internal `x-portkey-*` headers.

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

When adding new Knex migrations, keep the filenames lexically ordered (e.g., `20250201091500_new_feature.js`) so `knex migrate:latest` applies them predictably.
