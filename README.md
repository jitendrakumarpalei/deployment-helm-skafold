# StringCost Gateway Usage Guide

The StringCost gateway is a self-hosted build of Portkey's OpenAI-compatible proxy. It lets you point existing OpenAI clients (LangChain, the OpenAI SDK, cURL, etc.) at a single base URL while routing requests to any supported provider (OpenAI, Anthropic, Bedrock, Groq, …) simply by adjusting HTTP headers. This document explains exactly which headers we accept, how they map to Portkey’s configuration options, and how to construct them when you call the gateway.

- Gateway base URL: `https://api.stringcost.com/llm/v1`
- Health endpoint: `GET https://api.stringcost.com/healthz`
- All v1 endpoints exposed: `/chat/completions`, `/completions`, `/embeddings`, `/responses`, `/images/*`, `/audio/*`, `/files/*`, `/batches/*`, `/models`, `/realtime`.

All headers are brand-neutral (`x-stringcost-*`). The wrapper translates them into the underlying Portkey headers before requests reach the vendored gateway.

## Architecture at a Glance

- `apps/gateway`: Brand wrapper that authenticates clients, resolves provider configs, and then hands the request to the vendored Portkey router (imported from `vendor/portkey-gateway`) in-process—no double hop.
- `apps/control-plane`: Internal API that serves `/v1/account/config` and `/v2/models` so the gateway can hydrate provider credentials and catalog data without exposing Portkey branding.
- `apps/event-collector`: Receives raw usage events, persists them to the ledger, and enqueues classification jobs in a PostgreSQL `classification_jobs` cache table.
- `apps/worker`: Background worker that drains the classification queue, calls the meta classifier, and updates the ledger.
- `vendor/portkey-gateway`: Clean checkout of https://github.com/Portkey-AI/gateway (Git metadata removed). We track the upstream commit in `PORTKEY_TAG`.

Environment variables:

| Variable | Service | Purpose |
| --- | --- | --- |
| `CONTROL_PLANE_URL` | gateway | Base URL the wrapper calls to resolve provider configs before hitting Portkey |
| `ALBUS_BASEPATH` | vendored gateway | Mirrors `CONTROL_PLANE_URL` for Portkey’s internal control-plane hooks |
| `DATABASE_URL` | control-plane, ledger, event-collector, worker | PostgreSQL connection string |
| `META_LLM_CLASSIFIER_ENDPOINT`, `META_LLM_API_KEY` | worker | HTTP endpoint + key used by the classifier |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE` | worker | Optional tuning for queue polling |

Run migrations via the provided helpers:

```bash
# Ledger schema (billing tables, ledger events, invoices)
node --loader ts-node/esm apps/ledger/src/cli.ts migrate

# Control plane schema (API keys, provider credentials, model catalog)
node --loader ts-node/esm apps/control-plane/src/migrate.ts
```

Both migration scripts default to `DATABASE_URL`; pass `--database-url=...` to override.

## Required Authentication Headers

| Header | Purpose | Example |
| --- | --- | --- |
| `Authorization: Bearer <STRINGCOST_API_KEY>` | Authenticates your organization/workspace against StringCost. You obtain this key from StringCost billing. | `Authorization: Bearer sk-stringcost-123` |
| `x-stringcost-provider` | Provider to route the call to (`openai`, `anthropic`, `groq`, `bedrock`, etc.). Required unless the config object (see below) includes a provider or targets array. | `x-stringcost-provider: anthropic` |
| `x-stringcost-config` | JSON-encoded routing configuration identical to Portkey’s `config` option. Use this to supply virtual keys, retry logic, guardrails, dynamic targets, etc. | `x-stringcost-config: {"provider":"openai","virtual_key":"vk-openai-abc"}` |

You must send **either** `x-stringcost-provider` **or** a `provider`/`targets` field inside `x-stringcost-config`. Most clients send both for clarity.

## Optional Observability / Billing Headers

| Header | Purpose |
| --- | --- |
| `x-stringcost-run-id` | UUID for the agent run. Helps double-entry ledger grouping and metadata joins. If omitted we auto-generate a run id. |
| `x-stringcost-user-id` | Your internal user/customer identifier. Propagates into ledger events. |
| `x-stringcost-metadata` | JSON string with arbitrary metadata (category, funnel, etc.). Stored verbatim in the ledger. |
| `x-stringcost-custom-host` | Overrides host for provider calls (advanced escape hatch). Validated to avoid pointing back at StringCost/Portkey. |
| `x-stringcost-forward-headers` | Comma-separated list of headers we should pass through to the provider (for example custom telemetry, SSO tokens). |
| `x-stringcost-request-timeout` | Timeout in milliseconds for the upstream provider call. |
| `x-stringcost-strict-openai-compliance` | If set to `true`, enforces OpenAI request/response shapes even when routing to non-OpenAI providers. |

## Configuration (`x-stringcost-config`) Cheatsheet

The body of `x-stringcost-config` mirrors Portkey’s [config schema](https://portkey.ai/docs). Common fields include:

```json
{
  "provider": "anthropic",          // or omit and use targets
  "virtual_key": "vk-anthropic-123", // maps to your stored provider credential
  "retry": {
    "attempts": 3,
    "on_status_codes": [429, 500]
  },
  "targets": [                       // optional multi-provider routing
    {
      "provider": "anthropic",
      "weight": 1,
      "config": { "virtual_key": "vk-anthropic-123" }
    }
  ],
  "guardrails": {
    "default.contains": {
      "operator": "none",
      "words": ["classified", "internal"]
    }
  },
  "forward_headers": ["x-user-tier"],
  "metadata": { "experiment": "A/B-42" }
}
```

You can generate the header string with your language's JSON utilities or reuse Portkey's helper functions (`createHeaders`) as shown below.

## Example: LangChain (Python)

```python
from langchain_openai import ChatOpenAI
from portkey_ai import createHeaders, PORTKEY_GATEWAY_URL

STRINGCOST_API_KEY = "sk-stringcost-123"
VIRTUAL_KEY = "vk-anthropic-demo"  # stored in StringCost/Portkey portal

headers = createHeaders(
    api_key=STRINGCOST_API_KEY,
    virtual_key=VIRTUAL_KEY,
    provider="anthropic",
    metadata={"team": "support-bot"}
)
# Add run/user ids for ledger transparency
headers["x-stringcost-run-id"] = "d1b8ad8e-8e6d-4f4a-9acd-221c786f869b"
headers["x-stringcost-user-id"] = "user-42"

llm = ChatOpenAI(
    api_key="unused-when-virtual-key-present",
    base_url=f"{PORTKEY_GATEWAY_URL}/llm/v1",
    default_headers=headers,
    model="claude-3-opus-20240229"
)

resp = llm.invoke("Summarize our escalation policy in 3 bullet points")
print(resp.content)
```

Replacing `provider` and `virtual_key` switches providers: set `provider="openai"` and virtual key for OpenAI, or specify a `targets` array for fan-out routing.

## Example: LangChain (JavaScript)

```ts
import { ChatOpenAI } from '@langchain/openai';

const headers = {
  Authorization: 'Bearer sk-stringcost-123',
  'x-stringcost-provider': 'openai',
  'x-stringcost-config': JSON.stringify({
    virtual_key: 'vk-openai-main',
    retry: { attempts: 5, on_status_codes: [429] },
  }),
  'x-stringcost-run-id': crypto.randomUUID(),
  'x-stringcost-user-id': 'workspace-17',
};

const llm = new ChatOpenAI({
  apiKey: 'unused',
  model: 'gpt-4o-mini',
  configuration: {
    baseURL: 'https://api.stringcost.com/llm/v1',
  },
  clientOptions: {
    fetch: async (input, init = {}) => {
      const mergedHeaders = new Headers(init.headers || {});
      Object.entries(headers).forEach(([k, v]) => mergedHeaders.set(k, v));
      return fetch(input, { ...init, headers: mergedHeaders });
    },
  },
});

const answer = await llm.invoke('Give me three coffee bean origins with tasting notes.');
console.log(answer.content);
```

## Example: Raw REST call with `curl`

```bash
curl https://api.stringcost.com/llm/v1/chat/completions \
  -H "Authorization: Bearer sk-stringcost-123" \
  -H "Content-Type: application/json" \
  -H "x-stringcost-provider: anthropic" \
  -H "x-stringcost-config: {\"virtual_key\":\"vk-anthropic-prod\"}" \
  -H "x-stringcost-run-id: $(uuidgen)" \
  -d '{
        "model": "claude-3-haiku-20240307",
        "messages": [
          { "role": "user", "content": "Suggest a playful out-of-office message." }
        ]
      }'
```

## Virtual Keys

A virtual key is a pointer to the upstream provider credential you registered in the StringCost (Portkey) dashboard. You can:

1. Add provider secrets (OpenAI, Anthropic, AWS Bedrock, etc.) in the portal. Each secret receives a `virtual_key` string.
2. Pass that virtual key in `x-stringcost-config` so the gateway injects the underlying API key when calling the provider. This is why the `apiKey` parameter on SDK clients is often ignored (`virtual_key` takes precedence).
3. Rotate and scope access centrally without changing client code.

## Advanced Routing

- **Multiple targets**: Provide a `targets` array with weights to load-balance across providers or models.
- **Fallbacks**: Include a `fallbacks` array inside the config to retry a second provider/model when the primary fails.
- **Guardrails**: Use `guardrails`, `input_guardrails`, and `output_guardrails` blocks to apply modular checks (the names match Portkey plugins such as `default.contains`, `portkey.moderateContent`, etc.).
- **Retry Budget**: Use the `retry` object to control attempts, backoff (`interval`, `exponent`), and status codes that should trigger a retry.
- **Forwarding headers**: `x-stringcost-forward-headers: x-user-tier,x-session-id` tells the gateway which original headers to pass through when it calls the provider.

## Observability & Billing

Every request routed through the gateway produces a ledger entry (`ledger_events`) and enqueues the prompt for asynchronous classification. Provide meaningful `x-stringcost-run-id`, `x-stringcost-user-id`, and (optionally) `metadata` so invoices and analytics remain attributable. The worker consumes classification jobs from the PostgreSQL cache and updates each event’s `action_type` (e.g., `chat_completion`, `tool_selection`, `synthesis`). The cache uses an UNLOGGED table (`classification_jobs`) with automatic cleanup: leases expire after a configurable timeout and the worker trims rows older than the configured retention window on every batch.

## Quick Checklist

1. **Pick a provider or targets** and ensure a virtual key exists in the StringCost portal.
2. **Construct headers**:
   - `Authorization: Bearer <STRINGCOST_API_KEY>`
   - `x-stringcost-provider` or `x-stringcost-config` with `provider`/`targets` and `virtual_key`.
   - Optional observability headers (`run-id`, `user-id`, metadata).
3. **Point your client** to `https://api.stringcost.com/llm/v1` (for local testing you can hit `http://localhost:<port>/llm/v1`).
4. **Send requests normally**—the gateway rewrites headers, injects credentials, and forwards to the chosen provider.
5. **Inspect ledgers and classifications** via the StringCost billing tools to verify double-entry updates.

For additional configuration knobs (guardrails, conditional routing, streaming, Realtime) refer to Portkey’s configuration docs—the same payloads work here, only the header prefix changes to `x-stringcost-*`.

## Render / PM2 Deployment

`deploy/` contains assets for running every service on a single Render.com instance.

- **Build command:** `npm run deploy:build`
- **Start command:** `npm run deploy:start`

`deploy/ecosystem.config.cjs` configures PM2 Runtime to launch the control plane, gateway, event collector, and worker together. See `deploy/README.md` for required environment variables and local dry-run tips.

## Google App Engine Deployment

`deploy/appengine/` now contains templates for App Engine Standard. Copy `deploy/appengine/service-account.json.example` to `service-account.json` (or point `SERVICE_ACCOUNT_JSON` at your key) **and** copy `deploy/appengine/.env.example` to `deploy/appengine/.env`. Fill in your Cloud SQL socket URL, classifier settings, and (optionally) a Serverless VPC connector if you need private networking. Once the files are populated you can run:

```bash
gcloud config set project stringcost
npm run gae:deploy
```

Run `npm run gae:clean` afterwards if you want to remove the compiled artifacts (`apps/*/dist`, `vendor/portkey-gateway/build`, and the staged `app.yaml`). Review `deploy/appengine/README.md` for environment variables and deployment details.

## Local Development & Tests

Install dependencies with `npm install --no-audit --no-fund`.

The test suite spans multiple workspaces:

- `npm run test --workspace @stringcost/gateway` exercises the wrapper unit tests, including control-plane resolution (`tests/gateway/wrapper.test.ts`).
- `npm run test --workspace @stringcost/ledger` drives Postgres-backed scenarios (`tests/langchain/proxy.test.ts`, `tests/ledger/*.test.ts`). These rely on **Testcontainers**; ensure a database-capable container runtime (Docker or compatible) is available locally or in CI.
- `npm run test --workspace @stringcost/event-collector` and `npm run test --workspace @stringcost/worker` cover API and queue plumbing.

CI (GitHub Actions) provisions PostgreSQL for the integration tests. When running locally without Docker, export `TEST_DATABASE_URL` to point at an existing instance; otherwise the tests will fail while trying to launch containers.

## Control Plane API Contract

The gateway wrapper calls these StringCost-branded endpoints (served by `apps/control-plane`):

- `GET /healthz` – liveness check.
- `GET /v1/account/config?provider=openai` – returns `{ provider, config }`, where `config` matches Portkey’s expected structure (`provider`, `virtual_key`, `config.api_key`, optional metadata).
- `GET /v2/models` – returns the model catalog filtered to the caller’s API key and provider credentials. Responses mimic OpenAI’s `List Models` shape with the addition of `provider` and `virtual_key`.

Clients authenticate with `Authorization: Bearer <STRINGCOST_API_KEY>` or `x-stringcost-api-key`. The gateway surfaces the same API key that clients present on the public `/llm/v1/*` routes, keeping the control plane invisible to end users.
