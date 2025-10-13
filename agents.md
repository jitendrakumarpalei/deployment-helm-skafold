# StringCost Agents Architecture Specification

## 1. Engagement Methodology
The build follows the mandated Agent Playbook lifecycle. Each phase must be tracked in plan-mode and produce the listed exit criteria.

- **Phase 0 – Intake & Alignment:** Review all specs (`SPEC.md`, `GEMINI.md`, stakeholder notes), document KPIs, monetization goals, dependencies, and ensure stakeholder agreement on scope and billing targets.
- **Phase 1 – Step Graph Architecture:** Enumerate every agent thought, tool invocation, loop, and synthesis action. Define step boundaries, `actionType`, metadata (`unitCost`, token metrics, timers), and required headers (`X-Parent-Trace-Id`). Produce an approved reasoning/billing topology.
- **Phase 2 – Tooling & Infrastructure Readiness:** Register MCP servers in `McpRegistry`, provision or mock handlers, validate Vercel AI SDK bindings, quota, secrets, and plan `build.js`, route, and cron updates so all dependencies are callable in dev/staging.
- **Phase 3 – Agent Implementation:** Implement agents with `createAgent`, wrap every logical action in `step`, wire MCP helpers with `createMcpTool`, propagate trace headers, and keep branching logic explicit.
- **Phase 4 – Billing & Telemetry Instrumentation:** Set `unitCost`, calculators, and custom metrics per step; extend `BillingManager` if tiering/splits are required; run scenario scripts (e.g., vary `branches` in `agents/coffee-name-agent.ts`) to confirm invoice scaling.
- **Phase 4.5 – Scenario Coverage:** Ensure tree-of-thought agents emit per-branch steps with correct `unitCost`, tool-augmented agents mirror the coffee name generator smoke test, and each new agent has at least one automated test proving billing metadata integrity.
- **Phase 5 – Validation & Hardening:** Add focused unit/integration tests, exercise error paths (MCP outages, LLM timeouts, bad inputs), capture learnings in `SPEC.md`, and meet the quality bar before shipping.
- **Phase 6 – Packaging & Deployment:** Run `node build.js`, inspect `.vercel/output`, update `vercel.json`, perform local smoke tests, and deploy with `vercel deploy --prebuilt` while monitoring logs.
- **Phase 7 – Post-Deployment Monitoring:** Monitor traces, billing totals, KPIs, and alerts; gather user feedback; log retrospectives and debt items; close plan-mode once production is stable.

## 2. System Overview & Goals
StringCost delivers auditable, usage-metered billing for AI agents by instrumenting client-side frameworks and operating a Portkey-powered gateway plus a GKE-hosted billing backend. Key aims:

- **Double-entry event ledger:** Every agent step records vendor cost (`cost_cogs`) and customer revenue (`revenue_billed`) for full P&L visibility per run.
- **Asynchronous classification:** The proxy separates the live serving path from a background accounting path that enriches raw events without impacting latency.
- **Usage-metered, post-paid invoicing:** Aggregated usage rolls into monthly Stripe invoices with support for credits, discounts, VAT, and immutable audit trails.

## 3. Gateway-Centric Architecture with Self-Hosted Portkey
Portkey Gateway (https://github.com/Portkey-AI/gateway) is vendored into the StringCost monorepo (as a Git submodule or subtree) and deployed as part of our GKE stack. StringCost supplies metering, classification, billing, and a brand-neutral API wrapper around the gateway.

- **StringCost Gateway Wrapper:** A thin service (Hono/Express) that imports the Portkey router as an internal dependency, exposes StringCost-branded routes (`/llm/v1/...`), rewrites headers, runs auth/rate limiting, and invokes the Portkey handlers **directly in-process** (no outbound HTTP hop). No external endpoint contains the "portkey" name.
- **Portkey Gateway (self-hosted library):** Vendored source (e.g., `vendor/portkey-gateway`) built as part of our workspace. We avoid modifying upstream files; configuration is handled via JSON/env injection per https://portkey.ai/docs/integrations/libraries/openai-compatible.
- **Portkey Observability Hooks:** Configure Portkey "traces" webhooks or log sinks to push request/response metadata (prompt, completion, latency, token counts) to StringCost's Event Collector service. These payloads seed raw ledger events with `action_type = 'unknown'` and capture `provider`, `model`, and token metrics.
- **GKE Ingress & Load Balancer:** Exposes StringCost's internal APIs (`/api/stringcost`, `/api/v1/meter`, webhooks) and fronts the self-hosted Portkey deployment running within our cluster.
- **Event Collector Service (GKE Deployment):** Receives Portkey webhook callbacks, authenticates via shared secret, persists raw `LedgerEvents`, and inserts classification jobs into the PostgreSQL `classification_jobs` UNLOGGED table. Also handles reconciliation if Portkey batches logs.
- **Classification Cache (PostgreSQL UNLOGGED Table):** Acts as a durable-enough queue storing `{logId, promptContent, inserted_at, reserved_at}` awaiting meta-LLM classification (no external Redis dependency).
- **Background Workers (Cloud Run or GKE Jobs):** Consume classification queue, call meta-LLM, enrich ledger events (`action_type`, revenue tiers).
- **Billing Ledger (Cloud SQL for PostgreSQL):** Stores `LedgerEvents`, usage aggregations, and invoices. Remains the source of truth for double-entry accounting.
- **Egress (Cloud NAT Gateway):** Ensures stable outbound IPs for classification meta-LLM calls, Stripe, and any self-hosted Portkey components needing upstream access.

> **Note:** Portkey Cloud is not used. The open-source gateway is locked to a specific commit, vendored in the repository, and deployed alongside StringCost services in GKE for full control over routing, logging, and compliance requirements.

### 3.1 Portkey Source Management
- Add the Portkey gateway repository as a Git submodule inside `packages/portkey-gateway` (or vendor via subtree copy) pinned to an approved commit.
- Maintain a `PORTKEY_VERSION.md` noting upstream commit hash, local patches, and update procedures.
- Provide a wrapper package (e.g., `apps/gateway`) that imports the vendored Portkey router, mounts it under StringCost-branded routes, and exposes configuration files (`config/default.yaml`, provider secrets) plus Dockerfiles tailored to our environments.
- Integrate the gateway build into the workspace tooling (`pnpm build:gateway`, `npm run dev:gateway`) so CI/CD can build and deploy the service alongside other apps.

## 4. Agent Instrumentation Framework
Agent-side code instruments every step for tracing and billing.

```ts
// lib/framework.ts
import { trackUsage } from '@/lib/stringcost/server';

class BillingManager {
  private userId: string;
  constructor(userId: string) { this.userId = userId; }

  async record(event) {
    console.log(`   💰 BILLING EVENT: [Action: ${event.name}, Type: ${event.actionType}]`);
    await trackUsage({
      userId: this.userId,
      featureId: event.actionType,
      usage: Math.round(event.cost * 1000) || 1,
    });
  }
}

export async function step(parentContext, recordBillingEvent, options, workFn) {
  const startTime = Date.now();
  try {
    const output = await workFn();
    await recordBillingEvent({ ...options, outcome: 'success', duration: Date.now() - startTime });
    return output;
  } catch (error) {
    await recordBillingEvent({ ...options, outcome: 'failure', duration: Date.now() - startTime });
    throw error;
  }
}

export function createAgent(agentName, agentFn) {
  return {
    invoke: async (input) => {
      const billingManager = new BillingManager(input.userId);
      const rootContext = { runId: uuidv4() };
      const stepExecutor = (options, workFn) => step(rootContext, billingManager.record.bind(billingManager), options, workFn);
      const agentStep = Object.assign(stepExecutor, {
        context: rootContext,
        record: billingManager.record.bind(billingManager),
      });
      return agentFn(agentStep, input);
    },
  };
}
```

**Best practices:** Wrap every meaningful action in `step`, supply descriptive names and `actionType`, propagate trace headers for MCP tools, use low-level Vercel AI SDK helpers (`generateText`, `streamText`), and capture errors within steps so failures bind to the correct trace node.

## 5. Data Schemas
### 5.1 Ledger Events (Cloud SQL – PostgreSQL)
```sql
CREATE TABLE LedgerEvents (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  step_name VARCHAR(255),
  action_type VARCHAR(50) NOT NULL DEFAULT 'unknown',
  outcome VARCHAR(20) NOT NULL,
  duration_ms INTEGER,
  cost_cogs_micros BIGINT NOT NULL DEFAULT 0,
  revenue_billed_micros BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_run_id ON LedgerEvents(run_id);
```

### 5.2 Classification Job Payload (PostgreSQL Cache)
Entries in `classification_jobs` are stored as rows:

| Column | Type | Notes |
| --- | --- | --- |
| `job_id` | `bigserial` | Primary key |
| `log_id` | `uuid` | References the ledger event (unique) |
| `prompt_content` | `text` | Raw prompt to classify |
| `inserted_at` | `timestamptz` | Defaults to `now()` |
| `reserved_at` | `timestamptz` | Set when a worker leases the job |
| `attempts` | `int` | Incremented on each lease |

Example row:
```sql
INSERT INTO classification_jobs (log_id, prompt_content)
VALUES (
  'a7f2489d-5d1f-4d40-9b35-13c205a8c9d2',
  'Meta-LLM prompt requiring classification'
);
```

### 5.3 Usage-Metered Billing Tables (PostgreSQL)
| Table | Purpose | Key Columns |
| --- | --- | --- |
| `billing_rate` | Versioned price catalog | `resource_type`, `resource_family`, `location`, `unit_price`, `unit_name`, `effective_from`, `effective_to` |
| `project` | Billing entity | `id`, `name`, `billing_info_id`, `credit`, `discount_pct`, `created_at` |
| `billing_info` | Stripe customer metadata | `stripe_customer_id`, `country_code`, `tax_id`, `vat_registered` |
| `payment_method` | Stored Stripe payment method | `stripe_payment_method_id`, `brand`, `last4`, `exp_month`, `exp_year`, `preauth_amount`, `preauth_intent_id` |
| `billing_record` | Atomic daily usage | `project_id`, `resource_id`, `resource_name`, `span` (`[begin_of_day, end_of_day)`), `billing_rate_id`, `amount`, `created_at` |
| `invoice` | Monthly statement | `project_id`, `begin_time`, `end_time`, `invoice_number`, `status`, `content`, `subtotal`, `tax`, `total`, `created_at` |

**Indexes & Constraints:** GiST index on `billing_record.span`, exclusion constraint on `(resource_id WITH =, span WITH &&)` prevents overlapping daily rows.

## 6. API Endpoints & Service Flows

### 6.1 LLM Gateway (StringCost Wrapper)
- **Public Routes:** `POST https://api.stringcost.com/llm/v1/chat/completions`, `/llm/v1/completions`, `/llm/v1/embeddings`, `/llm/v1/images/*`, `/llm/v1/audio/*`, `/llm/v1/files/*`, `/llm/v1/batches/*`, `/llm/v1/responses/*`, `/llm/v1/models`, `/llm/v1/realtime` (WebSocket).
- **Authentication:** `Authorization: Bearer <STRINGCOST_API_KEY>` (validated by StringCost auth service). API keys map to Portkey configs internally.
- **Routing Headers:**
  - `x-stringcost-provider` / `x-stringcost-config` mirror Portkey's routing metadata. The wrapper converts them to `x-portkey-provider` / `x-portkey-config` before invoking the vendored handler.
  - `x-stringcost-run-id`, `x-stringcost-step-id`, and optional `x-parent-trace-id` propagate agent observability metadata into downstream logs.
- **Execution Flow:**
  1. Wrapper middleware authenticates the request, validates `run_id`, and persists a pre-flight ledger entry if needed.
  2. The wrapper creates an internal Hono `Context` targeting the vendored Portkey router (imported from `vendor/portkey-gateway/src/index`), translating paths and headers, **then calls the handler functions directly—no second HTTP hop**.
  3. Portkey executes routing, retries, guardrails, and provider calls. Responses stream back through the wrapper, which can append StringCost headers (`x-stringcost-ledger-id`, etc.).
  4. The wrapper triggers Portkey log plugins (via config) so payloads reach the Event Collector.
- **Brand Isolation:** External consumers never see "portkey" in URLs, headers, or error payloads. Any upstream error messages are normalized by the wrapper before returning to clients.

### 6.2 Client Action Gateway (Customer Apps)
- **Endpoint:** `POST /api/stringcost`.
- **Body:** `{ "action": "checkout" | "generate-invoice", "payload": { ... } }`.
- **Behavior:** Authenticate session → call server utility (`createCheckoutSession` or `generateAndFinalizeInvoice`) → return result to client.

### 6.3 Metering & Billing APIs (Internal)
- `POST /api/v1/meter`: ingest usage events.
- `GET /api/v1/usage/:project_id`: return aggregated usage.
- `GET /api/v1/invoice/:id`: fetch persisted invoice JSON.
- `POST /api/v1/invoice/generate`: manual invoice trigger.
- `POST /webhook/stripe`: handle Stripe webhooks for payment status.

### 6.2 Client Action Gateway (Customer Apps)
- **Endpoint:** `POST /api/stringcost`.
- **Body:** `{ "action": "checkout" | "generate-invoice", "payload": { ... } }`.
- **Behavior:** Authenticate session → call server utility (`createCheckoutSession` or `generateAndFinalizeInvoice`) → return result to client.

### 6.3 Metering & Billing APIs (Internal)
- `POST /api/v1/meter`: ingest usage events.
- `GET /api/v1/usage/:project_id`: return aggregated usage.
- `GET /api/v1/invoice/:id`: fetch persisted invoice JSON.
- `POST /api/v1/invoice/generate`: manual invoice trigger.
- `POST /webhook/stripe`: handle Stripe webhooks for payment status.

## 7. Asynchronous Classification Engine
A Cloud Run worker leases rows from the PostgreSQL `classification_jobs` cache, invokes a meta-LLM classifier, and enriches ledger events. Classification enables tiered billing and analytics.

### 7.1 Classification Flow
1. Event Collector receives Portkey webhook payload, writes raw ledger event, and inserts `{log_id, prompt_content}` into `classification_jobs`.
2. Worker leases pending rows (using `FOR UPDATE SKIP LOCKED` semantics), calls the meta-LLM (`META_LLM_CLASSIFIER_ENDPOINT`) with prompt: `"Analyze the following prompt. Classify the agent's intent as one of: [chat_completion, tool_selection, synthesis, generation, evaluation]."`
3. On success the worker updates the corresponding `LedgerEvents` row and deletes the `classification_jobs` entry; on failure it releases the row for retry.

- **Simple Chatbot:** Portkey logs provide conversation context; classification upgrades ledger row from `unknown` to `chat_completion`.
- **Tool-Calling (ReAct):** Use Portkey trace metadata to distinguish tool selection vs synthesis prompts, then enrich ledger pricing.
- **Tree-of-Thought Agent:**
  - Branch generation prompts → `generation`, billed at 2000 micros.
  - Branch evaluations → `evaluation`, billed per branch at 1000 micros.
  - Final aggregation prompt → `synthesis`, billed at 5000 micros.

## 8. Billing Pipeline & Stripe Integration
### 8.1 Metering Logic (No Kafka Ingestion)
- Emitters call Metering API with `{project_id, resource_id, resource_type, resource_family, location, usage_amount, timestamp}`.
- Fetch rate with time-bounded query by resource type/family/location and effective date.
- Compute daily `span = [date_trunc('day', timestamp), date_trunc('day', timestamp) + 1 day)`.
- Upsert into `billing_record`: `UPDATE` existing row adding `usage_amount`; on zero rows affected, `INSERT`; retry on exclusion conflicts.
- Result: one row per `{project, resource, rate, day}`, minimizing contention and enabling idempotent replays.

### 8.2 Monthly Invoice Generation
- **Schedule:** Cron `0 2 1 * *` (first day of month 02:00 UTC).
- **Process:**
  1. Select `billing_record` rows overlapping target month.
  2. Group by `project_id`, `billing_rate_id`; compute `amount × unit_price`.
  3. Apply discounts (`discount_pct`), consume credits (`project.credit`), clamp to zero.
  4. Evaluate VAT: issuer/customer location, `vat_registered`, and reverse-charge rules.
  5. Build invoice JSON summary (lines, subtotal, discount, credit_applied, vat_rate, tax, total).
  6. Persist `invoice` row with `status = 'unpaid'` and stored JSON for audit.
  7. Create Stripe Invoice + InvoiceItem, finalize, and charge automatically.
  8. Handle webhooks: `invoice.payment_succeeded` → mark paid; `invoice.payment_failed` → mark failed; `payment_method.detached` → suspend provisioning.

### 8.3 Stripe Setup & Verification
- Create Stripe Customer on project signup; attach payment method via client token.
- Perform small pre-authorization (e.g., $5) to validate cards (`preauth_amount`, `preauth_intent_id`).
- Store only Stripe IDs and non-sensitive metadata to remain PCI compliant.

### 8.4 Derived Analytics Views
- **Daily Usage Summary:** `SUM(amount * unit_price)` grouped by project and day.
- **Current Month Totals:** Filter `billing_record` where `lower(span)` in current month.
- **Auditability:** Invoice JSON contains resolved rate snapshots, enabling deterministic replays.

### 8.5 Scaling Without Kafka
- Batching happens at metering sources; control plane aggregates usage before writing.
- Daily coalesced rows keep locks short; GiST exclusion constraint guards overlap.
- Postgres handles concurrency; workers are cron-style loops (no Kafka/SQS).
- For higher throughput: maintain daily-row pattern, use prepared statements, consider partitioning `billing_record` by time if needed.

## 9. Testing Strategy
### 9.1 Portkey Gateway Integration
- **Unit Tests:** Mock Portkey webhook payloads to ensure Event Collector validates signatures, stores raw ledger events, and enqueues classification jobs. Validate wrapper behavior: StringCost headers translate to Portkey headers, unauthorized requests are rejected, and error payloads are normalized.
- **Integration Tests:** Use OpenAI-compatible clients to hit the StringCost wrapper endpoints (`/llm/v1/...`) while the wrapper mounts the vendored gateway in-process. Assert full flow: client → wrapper → Portkey handlers → upstream model → webhook/log → ledger entry.

### 9.2 Asynchronous Classification Worker
- **Unit:** Mock the Postgres client and meta-LLM. Test successful classification updates, meta-LLM failures (graceful handling, optional requeue), and malformed job payloads.
- **Integration:** With a test Postgres instance, insert a row into `classification_jobs`, run the worker, ensure the `LedgerEvents` row transitions from `unknown` to the classified type and the job is removed.

### 9.3 Double-Entry Ledger (DuckDB for Tests)
- Initialize fresh in-memory DuckDB with schema per suite.
- Simulate full run with multiple `LedgerEvents` (Portkey gateway events + agent framework steps). Verify SUM of `cost_cogs_micros` and `revenue_billed_micros` yields correct P&L.
- Test NOT NULL constraints by attempting invalid inserts.
- Optional concurrency tests: concurrent updates to same event to detect race conditions.

### 9.4 Billing Pipeline & Invoice Generation
- Unit test rate lookup, discount/credit math, VAT rules, invoice JSON structuring.
- Integration test monthly job with seeded `billing_record` rows, ensuring Stripe API is mocked yet assertions confirm invoice lifecycle.
- Scenario coverage for tree-of-thought, tool-augmented agents, and branch scaling to confirm billing metadata integrity (regression similar to `packages/framework/tests/billing.test.js`).

## 10. Environment & Local Development
- **Environment Variables:**
  - Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
  - Database & classification cache: `DATABASE_URL`.
  - LLM Providers: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
  - Portkey Gateway: `PORTKEY_API_KEY`, `PORTKEY_BASE_URL`, `PORTKEY_WEBHOOK_SECRET`, `PORTKEY_PRIVATE_KEY_PATH` (if TLS termination handled in-gateway).
  - Meta LLM Classifier: `META_LLM_CLASSIFIER_ENDPOINT`, `META_LLM_API_KEY`.
- **Local Stack:**
  - `git submodule update --init --recursive` (or script) to fetch the vendored gateway source.
  - `docker-compose up -d` for PostgreSQL.
  - `npm install` for dependencies.
  - `npm run dev:gateway` to launch the self-hosted Portkey gateway from source, `npm run dev:event-collector` (Portkey webhook receiver), `npm run dev:worker` (classification worker), `npm run dev:webapp` (Next.js UI/agent playground). For local development, run the gateway directly from the vendored package rather than using the hosted Docker image.

## 11. Deliverables & Tooling Expectations
- PostgreSQL migrations for all schemas (`LedgerEvents`, usage tables, invoices).
- Service modules: rate catalog loader, metering service (upsert logic), invoice service (aggregation, VAT, Stripe), Stripe service (customer/payment flows).
- Background jobs: daily usage rollup (optional dashboards), monthly invoice batch, classification worker.
- API endpoints and Stripe webhook handlers matching specifications.
- Agent framework primitives (`createAgent`, `step`, `BillingManager`) aligned with instrumentation and billing requirements.
- Portkey Gateway integration captured as code: vendored repository (commit hash, update process), configuration (routes, upstream providers, metadata propagation) expressed via IaC or documented runbooks in alignment with https://portkey.ai/docs/integrations/libraries/openai-compatible.
- StringCost Gateway Wrapper service (`apps/gateway`) providing brand-neutral `/llm/v1` routes, header translation, auth, and integration tests exercising the in-process Portkey router.
- Packaging via `node build.js`, `.vercel/output` verification, `vercel.json` updates, `vercel deploy --prebuilt` release path.
- Monitoring and logging for traces, billing totals, classification outcomes, Stripe payment events.
- Repository hygiene: keep the Portkey submodule synced, document local patches, and ensure CI validates the gateway build (`npm run lint:gateway`, `npm run test:gateway` if upstream tests are included).

## 12. Summary
This document consolidates all provided guidance for rebuilding StringCost from scratch: the Agent Playbook workflow, Portkey-integrated (yet brand-neutral) gateway architecture, double-entry ledger design, agent instrumentation framework, asynchronous classification logic, usage-metered billing pipeline, Stripe integration, testing strategy, and operational scaling principles without relying on Kafka. Implementations must adhere to these specifications to ensure agents remain transparent, debuggable, and billable with full auditability while leveraging Portkey's OpenAI-compatible gateway as the foundation of the serving path.
