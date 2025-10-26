# agents.md - StringCost Gateway & Billing Stack

*Last Updated: 2025-10-26*
*Project: StringCost - AI Gateway with Usage Tracking & Billing*
*Architecture: 4 Microservices on GKE + PostgreSQL + Vendored Portkey Gateway*

---

## 1. Timeline of Key Decisions

### Decision 1: Vendor Portkey Gateway vs Use as Service
**When:** Initial architecture discussion
**Context:** Need reliable AI gateway supporting 250+ LLM providers
**Options Considered:**
- Use Portkey's hosted service
- Self-host Portkey as separate deployment
- Vendor Portkey code directly into monorepo

**Decision:** Vendor Portkey gateway into `vendor/portkey-gateway/`
**Rationale:**
- Full control over gateway behavior
- No external service dependencies
- Can run in-process with wrapper for custom auth
- Pin to specific version for stability
- Track version in `PORTKEY_TAG`

**Impact:** Gateway service wraps Portkey in-process, complete control over routing

---

### Decision 2: Signed URLs vs Traditional API Keys
**When:** Security architecture design
**Context:** Need secure, time-limited access to AI gateway
**Options Considered:**
- Traditional API keys stored in database
- JWT tokens
- HMAC-signed URLs with encrypted config

**Decision:** HMAC-signed URLs with AES-256-GCM encrypted route config
**Rationale:**
- Time-limited (prevents replay attacks)
- Config embedded in URL (no gateway → control-plane roundtrip)
- Supports key rotation with multiple signing keys
- Session-scoped nonce for replay protection
- Stateless gateway design

**Impact:** Gateway validates signatures, no DB lookup per request

---

### Decision 3: Client-Provided API Keys Storage
**When:** Gemini API integration
**Context:** Allow clients to use their own provider API keys
**Options Considered:**
- Store keys in plaintext
- Store encrypted keys indefinitely
- Store encrypted keys with TTL and auto-deletion

**Decision:** pgcrypto-encrypted storage with pg_cron auto-cleanup
**Rationale:**
- Keys encrypted at rest (pgp_sym_encrypt)
- Configurable TTL (60-86400 seconds)
- Auto-delete with pg_cron hourly job
- Graceful fallback if pg_cron unavailable
- Per-client isolation with CASCADE delete

**Impact:** Secure temporary key storage, automatic cleanup

---

### Decision 4: Database Migrations Strategy
**When:** Kubernetes deployment planning
**Context:** Need reliable schema management across deployments
**Options Considered:**
- Manual migrations from laptop
- Init containers on each pod
- Pre-install/pre-upgrade Kubernetes Job

**Decision:** Kubernetes Job as Helm hook
**Rationale:**
- Runs once per deployment (not per pod)
- Blocks deployment if migrations fail (safe)
- Idempotent (Knex tracks applied migrations)
- Auto-deletes after completion (TTL)
- Works for both fresh deploys and schema updates

**Impact:** Automatic, safe migrations on every deploy

---

### Decision 5: Rate Limiting Implementation
**When:** Production hardening
**Context:** Prevent abuse of control-plane and gateway endpoints
**Options Considered:**
- In-memory rate limiting (loses state on restart)
- Redis-backed rate limiting
- PostgreSQL-backed rate limiting

**Decision:** PostgreSQL-backed rate limiting via `hono-rate-limiter` + `@acpr/rate-limit-postgresql`
**Rationale:**
- Reuses existing PostgreSQL database
- Persistent across restarts
- No additional Redis infrastructure
- Disabled in tests/dev via `DISABLE_RATE_LIMITING=true`
- Per-IP and per-endpoint limits

**Impact:** Production-ready rate limiting, no extra infrastructure

---

### Decision 6: Docker Build Strategy
**When:** CI/CD pipeline setup
**Context:** Need reproducible multi-stage builds
**Options Considered:**
- Simple single-stage Dockerfiles
- Multi-stage with full source copy
- Multi-stage with selective package.json copy

**Decision:** Multi-stage with package files copied first
**Rationale:**
- Better Docker layer caching (dependencies cached separately)
- Smaller final images (only runtime artifacts)
- Matches best practices for Node.js builds
- Gateway builds portkey-gateway first
- Uses `packages: 'external'` in esbuild to avoid bundling node_modules

**Impact:** Fast rebuilds, optimized image sizes

---

### Decision 7: Test Isolation Strategy
**When:** Fixing race conditions in tests
**Context:** Testcontainers tests failing with deadlocks and duplicate keys
**Options Considered:**
- Parallel test execution (default)
- Sequential test execution per file
- Separate databases per test file

**Decision:** Sequential test execution (`fileParallelism: false`)
**Rationale:**
- Simpler than managing multiple test databases
- Prevents database deadlocks during schema drops
- Testcontainers creates fresh database per suite
- Acceptable for CI/CD (tests complete in ~2 minutes)

**Impact:** Reliable test execution, no race conditions

---

### Decision 8: Smoke Test Architecture
**When:** Build verification setup
**Context:** Need to catch build issues before Docker/K8s deployment
**Options Considered:**
- Just run `npm test`
- Build locally without Docker
- Build with Docker

**Decision:** Both CI-style (no Docker) and Docker smoke tests
**Rationale:**
- CI-style test: Fast, mirrors exact Docker build steps
- Docker test: Verifies actual container builds
- Both test all 4 services independently
- CI-style useful for rapid iteration
- Docker test for pre-deployment validation

**Impact:** Catch build issues in <2 minutes instead of during K8s deploy

---

### Decision 9: Portkey Provider Naming
**When:** Gemini API integration
**Context:** Confusion about "gemini" vs "google" provider name
**Options Considered:**
- Use native Gemini API paths
- Use Portkey's naming convention
- Support both

**Decision:** Use Portkey's "google" provider name with OpenAI-compatible paths
**Rationale:**
- Portkey transforms OpenAI format → Gemini format automatically
- Unified API across all 250+ providers
- Leverages Portkey's provider abstractions
- Path: `/v1/chat/completions` (OpenAI-compatible)
- API key embedded in signed URL, not headers

**Impact:** Simple, unified API for all LLM providers

---

## 2. Pain Points / Lessons Learned

### Pain Point 1: Patches Directory Not Existing
**Issue:** All Dockerfiles copied non-existent `patches/` directory
**Impact:** Docker builds failing with "patches: not found"
**Solution:**
- Removed `COPY patches ./patches` from all Dockerfiles
- Confirmed no patches are needed (npm-only workspace)

**Lesson:** Always test Docker builds match CI smoke tests

---

### Pain Point 2: Migration Race Conditions
**Issue:** Multiple migrations trying to create pgcrypto extension simultaneously
**Impact:** "duplicate key violates unique constraint" errors
**Solution:**
- Remove redundant `CREATE EXTENSION pgcrypto` from later migrations
- Only create extension once in initial schema migration
- Knex handles migration locking automatically

**Lesson:** Extensions should be created once in initial schema

---

### Pain Point 3: Replay Store Persisting in Tests
**Issue:** Unit tests failing with 409 Conflict due to replay detection
**Impact:** Wrapper test expecting 200, getting 409
**Solution:**
- Mock `assertNonce` function in unit tests
- Only use real replay store in integration tests
- Clear in-memory store between tests

**Lesson:** Unit tests should mock external state (DB, replay store)

---

### Pain Point 4: esbuild Bundling node_modules
**Issue:** Services failing to start with "Dynamic require of 'events' is not supported"
**Impact:** Runtime errors in all services
**Solution:**
- Change `external: []` to `packages: 'external'` in build configs
- This tells esbuild to not bundle node_modules
- Services now require dependencies at runtime

**Lesson:** ESM builds should externalize node_modules for Node.js targets

---

### Pain Point 5: Smoke Test Not Mirroring Docker
**Issue:** Smoke test copied all files first, then installed dependencies
**Impact:** Could pass when Docker build fails (different order)
**Solution:**
- Update smoke test to match exact Docker flow:
  1. Copy package.json files
  2. npm install
  3. Copy all source
  4. Build
- Save PROJECT_ROOT at script start

**Lesson:** Smoke tests must EXACTLY mirror Docker multi-stage builds

---

### Pain Point 6: Classification Jobs Table Missing
**Issue:** Worker failing in K8s with "relation classification_jobs does not exist"
**Impact:** Worker crashlooping on startup
**Root Cause:** Migrations weren't running automatically in Kubernetes
**Solution:**
- Created Kubernetes Job as Helm pre-install/pre-upgrade hook
- Job runs both control-plane and ledger migrations
- Idempotent (Knex tracks applied migrations)
- Fails deployment if migrations fail (safe)

**Lesson:** Database migrations should be automated in K8s deployments

---

### Pain Point 7: Smoke Tests Not Testing Migrations
**Issue:** control-plane Docker image had multiple migration failures in sequence
**Impact:** Kubernetes migration Job failing with multiple errors:
1. "tsx not found"
2. After fixing tsx: "required configuration option 'client' is missing"

**Root Cause:** Development environment (where tests run) had all dev dependencies, but production Docker image stripped them. Smoke tests never replicated the production build.

**How It Slipped Through:**
- Development: `npm test` and `npm run migrate:*` worked fine (has all dev dependencies + source files)
- Production Docker: Dockerfile had `npm prune --omit=dev` which removed tsx
- Production Docker: Only copied `dist/`, not `src/` - knexfile.ts imports from `./src/knexConfig`
- Production Docker: Missing COPY commands for knex/ directories, knexfile.ts, tsconfig.json
- CI smoke test (`npm run smoke-test`) built in development mode, not production mode
- Docker smoke test (`npm run docker:smoke-test`) only tested service startup CMD, not migrations
- **Key insight:** We never tested migrations with the same build process that production uses

**The Sequential Failures:**
1. **First error:** "tsx not found" - dev dependency stripped by Docker
2. **After fixing tsx:** "client is missing" - knexfile.ts imports `./src/knexConfig` but only `dist/` was copied
3. **Root problem:** TypeScript knexfile imports source files, but Docker only has compiled dist

**Solution:**
- **Dockerfile fix (`apps/control-plane/Dockerfile`):**
  - Removed `npm prune --omit=dev` to keep tsx/knex
  - Added COPY for `src/` directories (control-plane and ledger) - needed by knexfile.ts imports
  - Added COPY for `tsconfig.json` (both workspaces) - needed by tsx
  - Added COPY for migration files and knexfiles (both control-plane and ledger)
  - Added COPY for `tsconfig.base.json` (root) - needed by tsx
- **CI smoke test fix (`scripts/smoke-test-build.sh`):**
  - Added `test_migrations()` function that verifies:
    - tsx, knex binaries exist
    - Migration files, knexfiles exist
    - `src/` directories and `src/knexConfig.ts` exist (for knexfile.ts imports)
    - `tsconfig.json` files exist (for tsx)
    - npm scripts are defined
  - Runs after build but before service start test
  - Only runs for control-plane (which handles both migrations)
- **Docker smoke test fix (`scripts/smoke-test-docker.sh`):**
  - Added similar `test_migrations()` function for Docker images
  - Validates all migration infrastructure inside Docker container

**Lesson:** Tests must use the SAME build process as production. TypeScript files in production images need their source dependencies, not just compiled output. Development environment != Production environment.

---

## 3. What Went Well

### ✅ Vendored Portkey Gateway Integration
Successfully integrated Portkey as a vendored dependency, allowing custom authentication wrapper while leveraging Portkey's 250+ provider support. The wrapper pattern (gateway → portkey in-process) works flawlessly.

### ✅ Signed URL Architecture
HMAC-signed URLs with encrypted route config provide secure, time-limited access without database lookups. Replay protection with PostgreSQL-backed nonce tracking.

### ✅ Automatic Database Migrations
Kubernetes Job runs migrations before deployment, ensuring schema is always up-to-date. Idempotent design means safe redeployment to same database.

### ✅ Comprehensive Test Suite
- Control-plane: 18 tests (client API keys, presign, URL tokens)
- Gateway: 8 tests (wrapper, API integration, replay protection)
- Ledger: 12 tests (migrations, events, worker, billing)
- All using Testcontainers for isolated PostgreSQL instances

### ✅ Multi-Service Docker Builds
All 4 services (gateway, control-plane, event-collector, worker) build successfully with optimized multi-stage Dockerfiles. Smoke tests verify each independently.

### ✅ Portkey Provider Abstraction
Using Portkey's "google" provider with OpenAI-compatible format works seamlessly. Automatic transformation to native Gemini API format.

### ✅ Rate Limiting Without Redis
PostgreSQL-backed rate limiting provides persistent limits without additional infrastructure. Easy to disable for tests/dev.

### ✅ Client-Provided API Keys
Secure temporary storage with pgcrypto encryption and pg_cron auto-deletion allows clients to use their own provider keys safely.

### ✅ Smoke Test Coverage
Both CI-style (no Docker) and Docker smoke tests catch build issues early. Tests mirror exact Docker build process.

### ✅ Helm-Based Deployment
Single Helm chart manages all 4 services with templating. Migration Job integrated as pre-install hook. Easy to add new services.

---

## 4. Outstanding Work & Recommendations

### 🔲 Implement Monitoring & Observability
**Priority:** High
**Effort:** Medium
**Why:** No visibility into request latency, error rates, or provider health
**Action:**
- Add OpenTelemetry instrumentation
- Export metrics to Google Cloud Monitoring
- Create dashboards for gateway throughput, provider latency, classification queue depth

---

### 🔲 Add Circuit Breakers (Issue #17)
**Priority:** High
**Effort:** Medium
**Why:** Failing provider calls can cascade and overwhelm the gateway
**Action:**
- Implement circuit breaker in gateway wrapper
- Per-provider circuit state
- Fail fast when provider is down

---

### 🔲 Implement Audit Logging (Issue #15)
**Priority:** Medium
**Effort:** Medium
**Why:** Partial implementation (request IDs exist), need full audit trail
**Action:**
- Create `audit_log` table
- Log presign requests, gateway calls, classification results
- Include actor, action, timestamp, outcome

---

### 🔲 Add Dependency Scanning (Issue #24)
**Priority:** Medium
**Effort:** Low
**Why:** No automated vulnerability scanning
**Action:**
- Add `npm audit` to CI
- Set up Dependabot or Renovate
- Block deployments on high/critical vulnerabilities

---

### 🔲 Document Secrets Rotation (Issue #20)
**Priority:** Medium
**Effort:** Low
**Why:** Code supports key rotation but no documentation
**Action:**
- Document URL_TOKEN_KEYS rotation procedure
- Document DATABASE_ENCRYPTION_KEY rotation
- Add runbook for emergency key rotation

---

### 🔲 Implement Health Checks with /readyz
**Priority:** High
**Effort:** Low
**Why:** Already referenced in Helm values but not implemented in apps
**Action:**
- Add `/healthz` and `/readyz` endpoints to all services
- `/healthz`: Liveness check (service is running)
- `/readyz`: Readiness check (database connected, dependencies available)

---

### 🔲 Add Horizontal Pod Autoscaling
**Priority:** Medium
**Effort:** Low
**Why:** Fixed replicas don't scale with load
**Action:**
- Add HPA resources to Helm chart
- Scale gateway and event-collector based on CPU/RPS
- Keep control-plane and worker at fixed replicas

---

### 🔲 Implement Request Tracing
**Priority:** Medium
**Effort:** Medium
**Why:** Difficult to trace requests across 4 services
**Action:**
- Use `X-Request-ID` header throughout
- Propagate trace context to all services
- Log trace ID in all log statements

---

### 🔲 Add Cost Attribution
**Priority:** High (business value)
**Effort:** Medium
**Why:** Ledger tracks costs but no attribution to projects/users
**Action:**
- Link `ledger_events` to `billing_info` via `user_id`
- Generate cost reports per customer
- Calculate profit margins (revenue - COGS)

---

### 🔲 Implement Dead Letter Queue UI
**Priority:** Low
**Effort:** Medium
**Why:** Failed classifications go to `classification_jobs_failed` with no visibility
**Action:**
- Add endpoint to query failed jobs
- Add retry mechanism for transient failures
- Alert on DLQ depth threshold

---

## 5. Architecture Overview

### Service Topology

```
Client → Gateway (8787) → Portkey (in-process) → AI Providers
            ↓ (presign)
         Control Plane (8080) → PostgreSQL (api_clients, signed_url_replays)
            ↓ (events)
         Event Collector (8080) → PostgreSQL (ledger_events, classification_jobs)
            ↓ (poll)
         Worker (8080) → Meta Classifier API
            ↓ (update)
         PostgreSQL (classification_jobs, ledger_events)
```

### Database Schema Separation

**Control Plane Tables:**
- `api_clients` - API client credentials
- `provider_credentials` - Provider API keys and virtual keys
- `client_api_keys` - Temporary client-provided keys (encrypted)
- `signed_url_replays` - Replay protection nonce tracking
- `provider_models` - Supported models per provider

**Ledger Tables:**
- `ledger_events` - Usage events (run_id, action_type, costs)
- `classification_jobs` - Unlogged queue for meta-classification
- `classification_jobs_failed` - Dead letter queue
- `billing_info`, `project`, `billing_rate`, `billing_record`, `invoice`

### Migration Tracking
- `control_plane_schema_migrations` - Knex migration tracking
- `ledger_schema_migrations` - Knex migration tracking

---

## 6. Source Files Worth Knowing

### Application Services

| Path | Role | Port |
|------|------|------|
| `apps/gateway/` | Gateway wrapper + Portkey | 8787 |
| `apps/control-plane/` | Presign, credentials, models | 8080 |
| `apps/event-collector/` | Ledger events + queue enqueue | 8080 |
| `apps/worker/` | Classification queue processor | 8080 |
| `apps/shared/` | Shared utilities (signedUrl, etc) | N/A |
| `vendor/portkey-gateway/` | Vendored Portkey gateway | N/A |

### Key Implementation Files

| Path | Purpose |
|------|---------|
| `apps/gateway/src/app.ts` | Gateway request handler, signature validation, Portkey integration |
| `apps/gateway/src/replayStore.ts` | PostgreSQL-backed replay protection |
| `apps/control-plane/src/server.ts` | Presign endpoint, client API key storage |
| `apps/control-plane/src/db.ts` | Database connection pooling |
| `apps/event-collector/src/server.ts` | Event ingestion, classification queue |
| `apps/worker/src/worker.ts` | Job polling, classification, ledger updates |
| `apps/worker/src/queue.ts` | Classification queue operations |
| `apps/shared/src/signedUrl.ts` | URL signing, config encryption/decryption |

### Migrations

| Path | Purpose |
|------|---------|
| `apps/control-plane/knex/migrations/20250101000000_initial_schema.js` | Initial control-plane schema |
| `apps/control-plane/knex/migrations/20251022000000_add_client_api_keys.js` | Client-provided API keys table |
| `apps/ledger/knex/migrations/20250101000000_initial_schema.js` | Ledger + classification_jobs tables |
| `apps/ledger/knex/migrations/20251021170000_add_failed_jobs_table.js` | Dead letter queue |

### Tests

| Path | Tests |
|------|-------|
| `tests/control-plane/urlToken.test.ts` | URL token signing/verification |
| `tests/control-plane/client_api_keys.test.ts` | Client key encryption/storage |
| `tests/control-plane/presign.api.test.ts` | Presign API integration (13 tests) |
| `tests/gateway/wrapper.test.ts` | Gateway wrapper unit tests |
| `tests/gateway/gateway.api.test.ts` | Gateway API integration (6 tests) |
| `tests/ledger/migrations.test.ts` | Ledger schema migrations |
| `tests/ledger/worker.test.ts` | Worker queue processing |
| `tests/langchain/proxy.test.ts` | End-to-end LangChain integration |

### Docker & Build

| Path | Purpose |
|------|---------|
| `apps/gateway/Dockerfile` | Multi-stage build (builds portkey-gateway) |
| `apps/control-plane/Dockerfile` | Multi-stage build |
| `apps/event-collector/Dockerfile` | Multi-stage build |
| `apps/worker/Dockerfile` | Multi-stage build |
| `apps/*/build.mjs` | esbuild configuration (packages: 'external') |
| `.dockerignore` | Excludes node_modules, dist, .git from builds |
| `scripts/smoke-test-build.sh` | CI-style build test (no Docker) |
| `scripts/smoke-test-docker.sh` | Docker build test (all 4 images) |

### Kubernetes Deployment

| Path | Purpose |
|------|---------|
| `deploy/gke/skaffold.yaml` | Build (Cloud Build) + deploy (Helm) |
| `deploy/gke/deploy.sh` | Main deployment script |
| `deploy/gke/helm/honojs-api/values.yaml` | Service configs, env vars, secrets |
| `deploy/gke/helm/honojs-api/templates/deployment.yaml` | Kubernetes Deployments |
| `deploy/gke/helm/honojs-api/templates/service.yaml` | Kubernetes Services |
| `deploy/gke/helm/honojs-api/templates/ingress.yaml` | GCE Ingress with path routing |
| `deploy/gke/helm/honojs-api/templates/migration-job.yaml` | Pre-install/pre-upgrade migration Job |
| `deploy/gke/DEPLOYMENT.md` | Complete deployment guide |

### Documentation

| Path | Purpose |
|------|---------|
| `README.md` | Main documentation, API usage, Quick Start |
| `PLAN.md` | Implementation plan, issue tracking (17/20 complete) |
| `agents.md` | This file - decisions, lessons, architecture |
| `deploy/gke/DEPLOYMENT.md` | Kubernetes deployment guide |

---

## 7. Environment Variables Reference

### Gateway
- `PORT` - Container port (default: 8787)
- `CONTROL_PLANE_URL` - Internal control plane URL
- `URL_TOKEN_KEYS` - HMAC signing keys (comma-separated)
- `SIGNED_URL_DATABASE_URL` - PostgreSQL for replay protection
- `DISABLE_RATE_LIMITING` - Set to "true" in tests/dev

### Control Plane
- `PORT` - Container port (default: 8080)
- `DATABASE_URL` - PostgreSQL connection string
- `DATABASE_ENCRYPTION_KEY` - For encrypting client API keys (pgcrypto)
- `URL_TOKEN_KEYS` - HMAC signing keys (must match gateway)
- `GATEWAY_BASE_URL` - Public gateway URL for presign responses
- `DISABLE_RATE_LIMITING` - Set to "true" in tests/dev

### Event Collector
- `PORT` - Container port (default: 8080)
- `DATABASE_URL` - PostgreSQL connection string
- `DISABLE_RATE_LIMITING` - Set to "true" in tests/dev

### Worker
- `PORT` - Container port (default: 8080)
- `DATABASE_URL` - PostgreSQL connection string
- `META_LLM_CLASSIFIER_ENDPOINT` - Meta classifier API URL
- `META_LLM_API_KEY` - Meta classifier API key
- `WORKER_POLL_INTERVAL_MS` - Queue polling interval (default: 200)

---

## 8. Quick Start Checklist

### Local Development
- [ ] Install: Node.js 20+, Docker (for tests), PostgreSQL 16
- [ ] Clone: `git clone https://github.com/stringcost/stringcost.git`
- [ ] Install: `npm install --no-audit --no-fund`
- [ ] Setup: Copy `.env.example`, configure `DATABASE_URL`
- [ ] Migrate: `npm run db:migrate`
- [ ] Seed: `npm run db:seed` (optional demo data)
- [ ] Test: `TESTCONTAINERS_RYUK_DISABLED=true npm test`
- [ ] Build: `npm run build`
- [ ] Smoke Test: `npm run smoke-test`

### GKE Deployment
- [ ] Install: `terraform`, `gcloud`, `kubectl`, `skaffold`, `helm`
- [ ] Authenticate: `gcloud auth application-default login`
- [ ] Provision: `cd deploy/gke/terraform && terraform apply`
- [ ] DNS: Add A record pointing to static IP
- [ ] Secrets: Create `stringcost-config` Kubernetes secret
- [ ] Deploy: `npm run gke:deploy`
- [ ] Verify: `kubectl get pods && kubectl logs job/honojs-apis-migrations-1`
- [ ] Wait: 15-60 min for SSL certificate provisioning
- [ ] Test: `curl https://yourdomain.com/llm/health`

---

## Contact & Support

For issues or questions:
1. Check troubleshooting sections in `README.md` and `DEPLOYMENT.md`
2. Review test suite for usage examples
3. Check `kubectl logs` for runtime issues
4. Check `kubectl get events` for Kubernetes issues
5. Review migration Job logs: `kubectl logs job/honojs-apis-migrations-<revision>`

---

*Architecture: 4 Microservices (Gateway, Control Plane, Event Collector, Worker)*
*Database: PostgreSQL 16 with Knex migrations*
*Gateway: Vendored Portkey supporting 250+ LLM providers*
*Deployment: GKE + Helm + Skaffold with automatic migrations*
