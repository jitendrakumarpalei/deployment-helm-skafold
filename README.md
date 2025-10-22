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

To run only the ledger integrations (LangChain proxy + worker + migrations):

```bash
TESTCONTAINERS_RYUK_DISABLED=true npm run test:ledger
```

Supertest-based API suites (gateway and control plane) must bind to a local socket. Enable them by exporting `ENABLE_SUPERTEST=true` before running the respective workspace tests (CI jobs set this automatically; sandboxes without socket access will skip these suites).

## Deploy to GKE (App Engine–style workflow)

You can deploy directly from this repository—no GitOps required. The Terraform stack provisions the cluster, static IP, and deployer service account; the `npm run gae:deploy` script uses Skaffold + Cloud Build to build/publish images and apply the Helm chart.

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

Create the runtime secret expected by the Helm chart (adjust values for your environment):

```bash
kubectl create secret generic stringcost-config \
  --from-literal=database_url="postgres://user:pass@host:5432/dbname" \
  --from-literal=classifier_endpoint="https://classifier.internal/v1/classify" \
  --from-literal=classifier_api_key="replace-me"
```

> If the optional dev/prod clusters are disabled, Terraform outputs the literal string `not created`. In that case the corresponding `export` is optional; the deploy script simply skips `dev`/`prod` profiles unless the clusters exist.

### 2. Deploy from your laptop (or CI runner)

```bash
cd deploy/gke
npm run gae:deploy        # main cluster (Cloud Build builds & pushes images)
# npm run gae:deploy:dev  # optional dev cluster (if created)
# npm run gae:deploy:prod # optional prod cluster (if created)
```

`npm run gae:deploy` runs `skaffold run`, which uses **Google Cloud Build** to build the Docker images defined in `apps/*/Dockerfile` and pushes them to Artifact/GCR before Helm rolls them out. No images are built locally by default; if you do local Docker work for debugging, you can clear stale layers afterwards with:

```bash
npm run docker:clean       # runs `docker image prune -af` (best-effort)
```

The deployment script activates the Terraform-generated service account, fetches cluster credentials, prunes old images from the registry, triggers Cloud Build via Skaffold, and finally applies the Helm release. Just rerun the command whenever you want to deploy new code.

## API Usage

Runtime requests no longer require custom headers. Instead, clients obtain a **one-use signed URL** from the control plane and then call that URL with the same headers they would send to the upstream provider (e.g., OpenAI or Anthropic). The signed URL encodes provider selection, virtual keys, run/user IDs, and optional extras (retry rules, metadata, body hash, etc.).

1. **Pre-sign** the target path using your StringCost API key (`Authorization: Bearer sk-stringcost-demo`).
2. **Invoke** the returned URL with your normal provider headers (`Authorization: Bearer sk-openai-...`).
3. **(Optional)** Emit additional ledger events to `/events` for tool calls or custom steps.

### 1. Generate a signed URL

```bash
curl -X POST https://api.stringcost.com/control/v1/presign \
  -H "Authorization: Bearer sk-stringcost-demo" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "openai",
        "method": "POST",
        "path": "/v1/chat/completions",
        "session_id": "018f1d5f-8aa5-7c93-a44a-53f97b07c1d3",
        "run_id": "6a9ab408-541f-40d3-af8a-5091c58cb89d",
        "user_id": "customer-4242",
        "virtual_key": "vk-openai-demo",
        "metadata": {"tier": "gold"},
        "config": {
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

### 2. Call the gateway using the signed URL

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

### Signed URL security notes

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
| `provider` | Which stored credential to use (`openai`, `anthropic`, `groq`, …). Optional if you supply `virtual_key`. |
| `virtual_key` | Explicit credential key to use (overrides `provider` default). |
| `method` | HTTP verb to lock the signed URL to (`POST`, `GET`, …). Defaults to `POST`. |
| `path` | Target path relative to `/llm` (e.g., `/v1/chat/completions`). |
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
