# StringCost Post-Mortem & Knowledge Capsule (October 2025)

This memo captures how the current StringCost codebase came together—from receiving the alternative specification through production hardening of the Portkey-based gateway, billing ledger, and CI/CD. It is written so a fresh Codex CLI session can understand the architecture, trade-offs, and unfinished business without re-reading the entire repository.

---

## 1. Timeline of Key Decisions

| Date (2025) | Decision / Event |
|-------------|------------------|
| Oct 8 | Received “StringCost Billing & Proxy System” spec mandating a Portkey-backed gateway, PostgreSQL ledger, and asynchronous classifier. |
| Oct 9 | Cloned Portkey gateway into `vendor/portkey-gateway` (commit `971c72a38cf0e0632f475365d71bda1020e4f66f`) and stripped its `.git` dir. Wrapper goal: avoid mutating upstream code to ease future pulls. |
| Oct 10 | Created initial `agents.md` (step graph + architecture), scaffolded Hono services (`apps/gateway`, `apps/control-plane`, `apps/event-collector`, `apps/worker`) plus TypeScript workspaces. |
| Oct 11 | Implemented Postgres migrations for control plane (`api_clients`, `provider_credentials`, `provider_models`) and ledger (`ledger_events`, `billing_record`, `invoice`, `classification_jobs`). Chose UNLOGGED classification queue over Redis per cost/simplicity guidance. |
| Oct 12 | Wired gateway wrapper to call Portkey **in-process** and to translate `x-stringcost-*` headers into `x-portkey-*`. Added LangChain integration test simulating config fetch → gateway call → event logging → worker classification. |
| Oct 13 | Added App Engine deployment scripts with config rendering + staging. Disabled vendored Portkey tests in CI to avoid upstream flakes. |
| Oct 14 | Deployed to GAE (gateway, control-plane, event-collector, worker). Fought with handler ordering & `/healthz` routes; the fix was mounting routers on both the root path and prefixed paths (e.g., `/control`). |
| Oct 15 | Introduced Postgres-only cache: removed Redis references, replaced queue with `classification_jobs` table + worker lease logic. Tests red due to gateway returning 502 (control plane config missing API key). |
| Oct 16 | Diagnosed 502 by enabling debug logs; control plane returned nested configs. Normalised config shape (copy `provider` and `api_key` to top-level) and forwarded `virtual_key` header → tests green. |
| Oct 16 | Standardised migration filenames and later moved the stack to Knex-based migrations/seeds to eliminate `node-pg-migrate` timestamp warnings. |
| Oct 17 | Updated README with accurate curl examples, environment instructions, and observability notes. |
| Oct 18 | Refactored runtime auth: introduced encrypted pre-signed URLs, dropped custom headers, added presign endpoint + shared AES/HMAC helpers. |
| Oct 18 | Replaced encrypted blob tokens with canonical HMAC-signed URLs (kid/session/nonce) + optional body hash and encrypted config payload. Added replay store integration. |
| Oct 18 | Added supertest gateway API suite gated by `ENABLE_SUPERTEST`; updated docs & tests to honour URL-only flow. |
| Oct 18 | This post-mortem drafted—documenting lessons, outstanding work, and recommended next steps. |

---

## 2. Current Architecture Snapshot

```
Clients (LangChain / SDKs / curl)
        │
        ├─ (1) POST /control/v1/presign → encrypted token / signed URL
        │
        ▼
  apps/gateway (Hono)
   ├─ Validate signed token (method/path/expiry/body hash)
   ├─ Inject Portkey headers (`x-portkey-provider`, config)
   └─ Call vendored portkey router in-process (no secondary hop)

Vendored Portkey Gateway
   ├─ Retry / routing / guardrails
   ├─ Provider SDK calls (OpenAI, Anthropic, etc.)
   └─ Observability hooks (forwarded to event collector)

  apps/event-collector (Hono)
   ├─ POST /events → insert ledger row + enqueue classification job
   └─ `/events` mounted at root & /events for App Engine dispatch

  PostgreSQL (Cloud SQL / local)
   ├─ ledger_events, billing_record, invoice
   ├─ api_clients, provider_credentials, provider_models
   └─ classification_jobs (UNLOGGED cache)

  apps/worker (Hono + background loop)
   ├─ startWorker(): poll classification_jobs with SKIP LOCKED
   ├─ call META_LLM_CLASSIFIER_ENDPOINT → update action_type
   └─ /healthz indicates worker status

  Stripe integration (planned): invoice generator + webhooks (not yet committed)
```

**Routing summary:**  
- Gateway exposes `/llm`, `/llm/*`.  
- Control plane exposes `/` and `/control/*` (same handlers).  
- Event collector exposes `/` and `/events/*`.  
- Wrapper log prints environment variables on boot for debugging (intentionally noisy until production config is stable).

---

## 3. Testing & CI

- **framework:** Vitest (v1.6.1) with Testcontainers for PostgreSQL; optional supertest API suites run when `ENABLE_SUPERTEST=true`.  
- **critical test:** `tests/langchain/proxy.test.ts` exercises the presign flow → signed URL invocation → event collector → worker classification; asserts ledger enrichment and queue drain.  
- **other tests:** migration smoke tests, worker classification, event collector API, gateway signed-token handling. Gateway API suite (`tests/gateway/gateway.api.test.ts`) is skipped automatically when sockets cannot be bound.  
- **migrations:** CI runs `npm run db:migrate` and `npm run db:seed` (demo workspace, provider creds, ledger sample data) before executing tests.
- **CI adjustments:**  
  - GitHub Actions (`.github/workflows/ci.yml`) runs Postgres and Redis services but only Postgres is used.  
  - `TESTCONTAINERS_RYUK_DISABLED=true` to avoid docker-in-docker permission issues.  
  - Vendored Portkey tests skipped via `echo`.  
- **migrations tooling:** switched from `node-pg-migrate` to Knex; keep timestamped filenames so `knex migrate:latest` applies them deterministically.

---

## 4. What Went Well

1. **Portkey integration without fork debt** – The wrapper imports `vendor/portkey-gateway/src/index` and manipulates headers/paths, so upgrading to a new upstream commit should only require replacing the vendor folder and updating `PORTKEY_TAG`.
2. **Brand isolation** – External consumers only see StringCost URLs/headers. Errors are normalised; no “portkey” leakage.
3. **Postgres-only queue** – Using an UNLOGGED table avoided Redis costs, satisfied the “no extra service” constraint, and is easy to test (all integration tests run with a single container).
4. **LangChain end-to-end test** – The high-friction path (config lookup + gateway + classifier) is covered, giving confidence we won’t regress on key headers.
5. **Deployment pipeline** – `deploy/appengine/deploy.sh` stages each service’s build output, renders service-specific YAML from `.env`, deploys with `--promote`, and prunes older versions to reduce spend.

---

## 5. Pain Points / Lessons Learned

| Issue | Root Cause | Resolution / Future Fix |
|-------|------------|-------------------------|
| 502s during tests | Control plane returned nested `config` object with API key under `config.config.api_key`. Portkey expected flattened `provider` + `api_key`. | Normalise response in gateway (`normalizedConfig`). |
| Hard-to-diagnose `/healthz` 404s | App Engine dispatch routes kept the `/control` prefix when handing off to the service; the handler only listened on `/`. | Mount handlers at both `/` and `/prefix` (Hono `.route('/control', ...)`). |
| CI warnings about timestamps | Legacy node-pg-migrate required fixed-length timestamps and complained about our filenames. | Adopted Knex migrations with millisecond timestamp prefixes (e.g., `20250101000000_initial_schema.js`). |
| Docker-in-Docker access | Testcontainers attempted to connect to Docker but Ryuk handshake failed in GHA. | Set `TESTCONTAINERS_RYUK_DISABLED=true` and rely on static Postgres service. |
| Verbose env dumps | Boot logs print every env var (debug). Useful during early deploys but noisy; should be gated by `DEBUG_*`. |
| Duplicate README/agents info | Early docs referenced hypothetical `SPEC.md`. Updated to stand-alone README & this post-mortem. |

---

## 6. Outstanding Work & Recommendations

### Functional
1. **Stripe billing pipeline** – `invoice` table exists, but Stripe webhook handlers and invoice generation jobs are still todo. The spec expects monthly summarisation and credit application.
2. **Cache retention** – Classification jobs table could grow. Implement scheduled cleanup (e.g., delete rows older than X hours) and monitor queue depth.
3. **Worker resilience** – Add dead-letter strategy or exponential backoff for classifier failures; currently the job simply retries when polled again.
4. **Control plane auth** – API keys stored in cleartext (per spec). Consider hashing or wrapping with envelope encryption if compliance requires.
5. **Rate limiting & quotas** – Gateway does not yet enforce per-API key limits. Add middleware once usage tiers are defined.
6. **Observability** – Integrate structured logging and metrics (latency, error counts) for each Hono service.

### Testing & Tooling
1. **Add snapshot tests for billing ledger** – e.g., generate invoice after synthetic run to validate aggregation logic.  
2. **Expand LangChain coverage** – Add tests for tool-calling, ToT scenarios so classification heuristics stay accurate.  
3. **CI speed** – Currently ~30s per ledger suite; can split heavy test job or use `vitest --runInBand` to avoid concurrent container spin-ups.  
4. **Pre-commit linting** – Optional but recommended (ESLint/Prettier).  

### Documentation
1. **Control plane API docs** – Document JSON schema for `/control/v1/account/config` and required fields in README or dedicated doc.  
2. **Portkey upgrade playbook** – Outline procedure for pulling new commit, running vendor tests locally, and updating `PORTKEY_TAG`.  
3. **Incident response** – Add runbooks for common failures (classifier down, ledger lock errors, Stripe webhook retry storms).

---

## 7. Source Files Worth Knowing

| Path | Role / Highlights |
|------|-------------------|
| `apps/gateway/src/app.ts` | Validates signed tokens, injects Portkey headers, computes body hashes, forwards to vendored router. |
| `apps/gateway/src/middleware/requestAdapter.ts` | Rewrites `/llm` prefix and strips signing query params before handing off. |
| `apps/control-plane/src/server.ts` | Hono routes for `/healthz`, `/v1/presign`, `/v1/account/config`, `/v2/models`. Includes debug logging. |
| `apps/control-plane/src/db.ts` | Connection pool singleton + `closePool()` (added for integration test cleanup). |
| `apps/event-collector/src/server.ts` | Accepts events at `/` and `/events`, validates required fields, enqueues classification job. |
| `apps/worker/src/worker.ts` | Implements `startWorker()`; leases rows from `classification_jobs` and updates ledger. |
| `tests/langchain/proxy.test.ts` | End-to-end test covering control plane → gateway → event collector → worker. |
| `tests/control-plane/presign.api.test.ts` | Supertest smoke for `/v1/presign`, gated by `ENABLE_SUPERTEST`. |
| `tests/gateway/gateway.api.test.ts` | Supertest suite validating signed URL enforcement (skips automatically when sockets cannot be bound). |
| `apps/shared/signedUrl.ts` | Canonical signing utilities (HMAC) and config encryption helpers used by presign + gateway validation. |
| `deploy/appengine/deploy.sh` | Builds, stages, and deploys all services with `--promote --stop-previous-version`; includes version pruning. |
| `PORTKEY_TAG` | Homed commit of vendored Portkey gateway (`971c72a38cf0e0632f475365d71bda1020e4f66f`). |

---

## 8. Quick Reference: Presign & Invoke

### Step 1 – get a one-use URL

```bash
curl -X POST https://api.stringcost.com/control/v1/presign \
  -H "Authorization: Bearer sk-stringcost-demo" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "openai",
        "method": "POST",
        "path": "/v1/chat/completions",
        "session_id": "018f1d5f-8aa5-7c93-a44a-53f97b07c1d3",
        "run_id": "$(uuidgen)",
        "user_id": "customer-4242",
        "metadata": {"environment": "prod"},
        "config": {"virtual_key": "vk-openai-prod"}
      }'
```

### Step 2 – call the proxy with provider headers

```bash
curl "https://api.stringcost.com/llm/v1/chat/completions?kid=...&client=...&...&sig=..." \
  -H "Authorization: Bearer sk-openai-demo" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-4o-mini",
        "messages": [{"role":"user","content":"Say hi to the finance team"}]
      }'
```

### Step 3 – optional explicit ledger event

```bash
curl https://api.stringcost.com/events \
  -H "Content-Type: application/json" \
  -d '{"run_id":"…","user_id":"…","outcome":"success","action_type":"tool_selection","prompt_content":"..."}'
```

---

## 9. Final Thoughts

- The system now meets the spec’s core requirements: Portkey integration, control plane, ledger with asynchronous classification, and unit/integration tests.  
- Stripe billing pipeline, rate limits, and production-ready observability remain open.  
- The codebase adheres to the “vendor untouched” rule; future upgrades should simply replace `vendor/portkey-gateway` and update `PORTKEY_TAG`.  
- All migrations use millisecond timestamps; keep this convention to avoid CI noise.  
- Tests depend on Docker access; always export `TESTCONTAINERS_RYUK_DISABLED=true` in constrained environments.

This document should be updated after major architectural changes (e.g., switching message queue, adding multi-region support, introducing new worker types). For day-to-day work, consult the README for command basics and this memo for architectural intent.
