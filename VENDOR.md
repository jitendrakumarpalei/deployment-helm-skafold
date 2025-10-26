# Portkey AI Gateway Integration

**Last Updated:** 2025-10-26
**Portkey Version:** v1.12.3
**Pinned Commit:** `971c72a38cf0e0632f475365d71bda1020e4f66f`

---

## Overview

StringCost vendors the [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) as an **in-process library** rather than using it as an external service. This gives us complete control over routing, authentication, and response handling while leveraging Portkey's battle-tested support for 250+ LLM providers.

## Why Vendor Portkey?

### Decision Rationale

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Hosted Portkey Service** | No maintenance | ❌ External dependency<br>❌ No custom auth<br>❌ Additional network hop | ❌ Rejected |
| **Self-hosted Portkey** | Updates easier | ❌ Separate deployment<br>❌ Network overhead<br>❌ Still need wrapper auth | ❌ Rejected |
| **Vendored In-Process** | ✅ Full control<br>✅ No network hop<br>✅ Custom auth wrapper<br>✅ Version stability | Manual updates | ✅ **Chosen** |

### Key Benefits

1. **Zero Network Latency** - Portkey runs in the same process as our gateway wrapper
2. **Custom Authentication** - We control auth with signed URLs before Portkey sees the request
3. **Brand Control** - We strip `x-portkey-*` headers and replace with `x-stringcost-*`
4. **Version Stability** - Pinned to specific commit, no surprise breaking changes
5. **Full Transparency** - Complete access to Portkey's source code for debugging

---

## Architecture

### High-Level Flow

```mermaid
graph TB
    subgraph "Client Layer"
        Client[Client Application<br/>LangChain/OpenAI SDK]
    end

    subgraph "External Services"
        OpenAI[OpenAI API]
        Anthropic[Anthropic API]
        Gemini[Google Gemini]
        Other[Other LLM Providers<br/>250+ supported]
    end

    subgraph "StringCost Gateway Service :8787"
        subgraph "Hono Wrapper App"
            SignedURL[Signed URL Verifier<br/>HMAC + Replay Protection]
            RateLimit[Rate Limiter<br/>PostgreSQL-backed]
            ReqAdapter[Request Adapter<br/>Strip params, add headers]
            RespAdapter[Response Adapter<br/>Portkey → StringCost rebrand]
        end

        subgraph "Vendored Portkey Gateway"
            PortkeyRouter[Portkey Router<br/>x-portkey-provider header]
            PortkeyMiddleware[Portkey Middleware<br/>Retry, Fallback, Cache]
            ProviderAdapters[Provider Adapters<br/>OpenAI, Anthropic, etc.]
        end

        ReplayStore[(Replay Store<br/>signed_url_replays<br/>PostgreSQL)]
    end

    subgraph "StringCost Control Plane :8080"
        ControlPlane[Control Plane API<br/>Issues signed URLs]
        CredStore[(Provider Credentials<br/>provider_credentials<br/>api_clients<br/>PostgreSQL)]
    end

    %% Client gets signed URL
    Client -->|1. POST /control/v1/presign<br/>Bearer sk-stringcost-xxx| ControlPlane
    ControlPlane -->|Read credentials| CredStore
    ControlPlane -.->|2. Return signed URL<br/>+ encrypted route config| Client

    %% Gateway request flow
    Client -->|3. POST /llm/v1/chat/completions<br/>Signed URL with ?kid=...| SignedURL
    SignedURL -->|Verify HMAC| SignedURL
    SignedURL -->|Check replay| ReplayStore
    SignedURL -->|4. Apply rate limit| RateLimit
    RateLimit -->|5. Adapt request| ReqAdapter

    %% Portkey processing
    ReqAdapter -->|6. Forward with headers:<br/>x-portkey-provider<br/>x-portkey-config<br/>x-portkey-virtual-key| PortkeyRouter
    PortkeyRouter -->|7. Apply middleware| PortkeyMiddleware
    PortkeyMiddleware -->|8. Route to provider| ProviderAdapters

    %% Provider calls
    ProviderAdapters -->|HTTP request| OpenAI
    ProviderAdapters -->|HTTP request| Anthropic
    ProviderAdapters -->|HTTP request| Gemini
    ProviderAdapters -->|HTTP request| Other

    %% Response flow
    OpenAI -.->|Provider response| ProviderAdapters
    Anthropic -.->|Provider response| ProviderAdapters
    Gemini -.->|Provider response| ProviderAdapters
    Other -.->|Provider response| ProviderAdapters

    ProviderAdapters -.->|9. Portkey response<br/>with x-portkey-* headers| RespAdapter
    RespAdapter -.->|10. Rebranded response<br/>with x-stringcost-* headers| Client

    %% Styling
    classDef clientStyle fill:#e1f5ff,stroke:#01579b,stroke-width:2px
    classDef wrapperStyle fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef portkeyStyle fill:#fce4ec,stroke:#880e4f,stroke-width:3px
    classDef dbStyle fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef externalStyle fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef controlStyle fill:#fff9c4,stroke:#f57f17,stroke-width:2px

    class Client clientStyle
    class SignedURL,RateLimit,ReqAdapter,RespAdapter wrapperStyle
    class PortkeyRouter,PortkeyMiddleware,ProviderAdapters portkeyStyle
    class ReplayStore,CredStore dbStyle
    class OpenAI,Anthropic,Gemini,Other externalStyle
    class ControlPlane controlStyle
```

### Request Flow Details

#### 1. Client Authentication (Control Plane)

```bash
POST https://api.stringcost.com/control/v1/presign
Authorization: Bearer sk-stringcost-abc123

{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "virtualKeyId": "vk-123"
}
```

**Control plane returns:**
```json
{
  "signedUrl": "https://api.stringcost.com/llm/v1/chat/completions?kid=k1&client=c123&provider=openai&exp=1234567890&cfg=<encrypted>&sig=<hmac>",
  "expiresAt": "2025-10-26T12:00:00Z"
}
```

#### 2. Gateway Request Processing

**Wrapper Steps (Before Portkey):**

1. **Verify Signed URL** (`apps/gateway/src/app.ts:33-66`)
   - Validate HMAC signature
   - Check expiration timestamp
   - Verify body hash if present
   - Decrypt route config from `cfg` param

2. **Replay Protection** (`apps/gateway/src/app.ts:58-62`)
   - Check `(sessionId, nonce)` in PostgreSQL
   - Insert nonce with TTL = URL expiration
   - Return 409 Conflict if replay detected

3. **Rate Limiting** (`apps/gateway/src/app.ts:68-75`)
   - PostgreSQL-backed rate limiter
   - Key: `clientId` from verified signed URL
   - Limit: 1000 requests per minute per client

4. **Request Adaptation** (`apps/gateway/src/app.ts:78-127`)
   - Strip signed URL query params (`kid`, `sig`, `cfg`, etc.)
   - Add Portkey headers:
     - `x-portkey-provider: openai` (from verified `provider` field)
     - `x-portkey-config: {...}` (decrypted route config)
     - `x-portkey-virtual-key: vk-123` (if present)
   - Add StringCost headers:
     - `x-stringcost-run-id` (for tracing)
     - `x-stringcost-user-id` (for user attribution)
     - `x-stringcost-metadata` (custom metadata)
     - `x-stringcost-scope` (billing scope)

**Portkey Processing (Vendored Code):**

5. **Portkey Router** (`vendor/portkey-gateway/src/index.ts`)
   - Reads `x-portkey-provider` header
   - Selects provider adapter (OpenAI, Anthropic, etc.)
   - Applies `x-portkey-config` (retry, fallback, cache settings)

6. **Portkey Middleware** (`vendor/portkey-gateway/src/middlewares/`)
   - **Retries** - Exponential backoff on 5xx errors
   - **Fallbacks** - Switch to backup provider on failure
   - **Caching** - Semantic caching if enabled
   - **Guardrails** - Content filtering if configured

7. **Provider Adapter** (`vendor/portkey-gateway/src/providers/openai/`)
   - Transforms request to provider-specific format
   - Adds provider authentication (`Authorization: Bearer sk-openai-***`)
   - Makes HTTP request to provider API

#### 3. Response Handling

**Portkey Returns:**
```
HTTP/1.1 200 OK
x-portkey-trace-id: abc123
x-portkey-llm-provider: openai
x-portkey-cache-status: miss
Content-Type: application/json

{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "model": "gpt-4o-mini",
  ...
}
```

**Response Adapter** (`apps/gateway/src/middleware/responseAdapter.ts:8-50`)

1. **Header Rebranding**
   - `x-portkey-*` → `x-stringcost-*`
   - Example: `x-portkey-trace-id` → `x-stringcost-trace-id`

2. **Body Rebranding** (for JSON/text responses)
   - Replace all `x-portkey-` with `x-stringcost-`
   - Replace word `portkey` with `stringcost`
   - Update `content-length` header

**Client Receives:**
```
HTTP/1.1 200 OK
x-stringcost-trace-id: abc123
x-stringcost-llm-provider: openai
x-stringcost-cache-status: miss
Content-Type: application/json

{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "model": "gpt-4o-mini",
  ...
}
```

---

## Portkey Features We Use

### 1. Provider Routing (`x-portkey-provider`)

Portkey supports 250+ providers. We use the `x-portkey-provider` header to route requests.

**Example providers we support:**
- `openai` - OpenAI (GPT-4, GPT-4o, GPT-3.5)
- `anthropic` - Anthropic (Claude 3.5 Sonnet, Claude 3 Opus)
- `google` - Google Gemini (gemini-pro, gemini-flash)
- `azure-openai` - Azure OpenAI Service
- `bedrock` - AWS Bedrock (Claude, Llama, etc.)
- `cohere` - Cohere (Command, Embed)
- `groq` - Groq (Llama 3, Mixtral)
- `together-ai` - Together AI
- `fireworks-ai` - Fireworks AI
- And 240+ more...

**See:** `vendor/portkey-gateway/src/providers/` for full list

### 2. Virtual Keys (`x-portkey-virtual-key`)

Portkey has a concept of "virtual keys" - stored provider credentials that can be referenced by ID.

**How StringCost uses this:**
- Control plane stores provider credentials in `provider_credentials` table
- Each credential has a `virtual_key_id` (e.g., `vk-openai-prod-123`)
- When issuing signed URL, control plane includes `virtual_key` in encrypted config
- Gateway forwards as `x-portkey-virtual-key: vk-openai-prod-123`
- Portkey looks up actual API key and authenticates with provider

**Why this matters:**
- Client never sees provider API key
- Credentials centrally managed in control plane
- Can rotate keys without changing client code

### 3. Route Config (`x-portkey-config`)

Portkey's most powerful feature - JSON config defining routing behavior.

**Example config:**
```json
{
  "retry": {
    "attempts": 3,
    "on_status_codes": [429, 500, 502, 503]
  },
  "cache": {
    "mode": "semantic",
    "max_age": 3600
  },
  "request_timeout": 30000
}
```

**StringCost usage:**
- Control plane encrypts route config in signed URL (`cfg` param)
- Gateway decrypts and forwards as `x-portkey-config` header
- Portkey applies config to request

**Supported config options:**
- `retry` - Retry failed requests
- `fallback` - Switch to backup provider
- `cache` - Cache responses (semantic or simple)
- `load_balance` - Distribute across providers
- `request_timeout` - Max request duration
- `guardrails` - Content filtering rules

**See:** Portkey docs for full config reference

### 4. Streaming Support

Portkey natively supports streaming for all providers.

**StringCost implementation:**
- Client sends `stream: true` in request body
- Portkey returns SSE (Server-Sent Events) stream
- Gateway pipes stream directly to client (no buffering)
- Response adapter handles SSE data chunks

**Example:**
```bash
curl https://api.stringcost.com/llm/v1/chat/completions?kid=... \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[...],"stream":true}'

# Response:
data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-123","choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

### 5. Provider-Specific Transformations

Portkey automatically handles provider differences.

**Examples:**

| Feature | OpenAI Format | Anthropic Format | Portkey Handles |
|---------|---------------|------------------|-----------------|
| System messages | `role: "system"` | Separate `system` param | ✅ Yes |
| Tool calls | `tools` array | `tools` array | ✅ Yes |
| Streaming | SSE format | SSE format | ✅ Yes |
| Vision | `image_url` in content | `image` in content | ✅ Yes |

**Benefit:** Clients use OpenAI format for all providers. Portkey translates.

### 6. Guardrails (Unused in StringCost)

Portkey supports content filtering plugins:
- PII detection
- Toxic content filtering
- Prompt injection detection

**StringCost approach:**
- We don't use Portkey's guardrails
- Instead: Meta classifier runs post-request in worker
- Classification stored in ledger for billing/analytics

**Why:** Our classification is asynchronous and doesn't block requests.

---

## Files & Integration Points

### Gateway Wrapper (`apps/gateway/`)

**Main Application** - `src/app.ts` (174 lines)
- Imports vendored Portkey: `import portkeyApp from '../../../vendor/portkey-gateway/src/index'`
- Wraps Portkey with StringCost auth and rate limiting
- Forwards requests to `portkeyApp.fetch(forwardedRequest, env, executionCtx)`

**Request Adapter** - `src/middleware/requestAdapter.ts`
- Creates new Request object with modified headers
- Strips signed URL query params
- Preserves body for POST/PUT requests

**Response Adapter** - `src/middleware/responseAdapter.ts` (51 lines)
- Rebrands `x-portkey-*` → `x-stringcost-*` in headers
- Rebrands body text (for JSON/text content types)
- Updates `content-length` after modifications

**Replay Store** - `src/replayStore.ts`
- PostgreSQL-backed nonce tracking
- Fallback to in-memory Map if DATABASE_URL missing
- TTL = signed URL expiration time

**Build Script** - `build.mjs`
- Copies vendored Portkey to `dist/vendor/portkey-gateway/`
- Bundles gateway wrapper with esbuild
- Sets `packages: 'external'` to avoid bundling node_modules

### Vendored Portkey (`vendor/portkey-gateway/`)

**Source Location:** `vendor/portkey-gateway/`
**Version Pinned:** `PORTKEY_TAG` file contains commit hash `971c72a38cf0e0632f475365d71bda1020e4f66f`

**Key Portkey Files:**
- `src/index.ts` - Main Hono app
- `src/providers/` - Provider adapters (OpenAI, Anthropic, etc.)
- `src/middlewares/` - Retry, cache, guardrails
- `src/handlers/` - Route handlers (`/v1/chat/completions`, etc.)
- `plugins/` - Guardrail plugins (unused by StringCost)

**Portkey Dependencies:** (from `vendor/portkey-gateway/package.json`)
- `hono: ^4.6.10` - HTTP framework
- `jose: ^6.0.11` - JWT handling
- `zod: ^3.22.4` - Schema validation
- `@aws-crypto/sha256-js` - AWS signature
- `@smithy/signature-v4` - AWS auth
- `ws: ^8.18.0` - WebSocket support

**Build Process:**
1. Portkey is **not** built separately
2. Gateway's `build.mjs` copies Portkey source to `dist/`
3. Gateway imports Portkey directly: `import portkeyApp from '../../../vendor/portkey-gateway/src/index'`
4. Portkey code is bundled with gateway via esbuild

### Docker Build

**Gateway Dockerfile** - `apps/gateway/Dockerfile`
```dockerfile
# Copy vendor directory (includes Portkey)
COPY vendor ./vendor

# Build step compiles both gateway and Portkey
RUN npm run build --workspace @stringcost/gateway

# Runtime: Only needs dist/ (includes bundled Portkey)
COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
```

**Key point:** Portkey is copied as source, built with gateway, bundled into `dist/`.

---

## Portkey-Specific Environment Variables

### Gateway Service

The following environment variables affect Portkey behavior:

| Variable | Purpose | Example | Notes |
|----------|---------|---------|-------|
| `DEBUG_GATEWAY_FORWARD` | Log Portkey responses | `"1"` | Logs response status/body for debugging |
| (none) | | | Portkey uses headers, not env vars |

### Portkey Configuration via Headers

All Portkey configuration happens via request headers:

| Header | Set By | Purpose |
|--------|--------|---------|
| `x-portkey-provider` | Gateway wrapper | Provider to route to (`openai`, `anthropic`, etc.) |
| `x-portkey-config` | Gateway wrapper | JSON config (retry, fallback, cache) |
| `x-portkey-virtual-key` | Gateway wrapper | Virtual key ID for credential lookup |

### Legacy: ALBUS_BASEPATH (Removed)

**Historical context:**
- Portkey has a UI called "Albus" for managing configs
- `ALBUS_BASEPATH` env var pointed Albus UI to control plane
- StringCost previously mentioned this in README

**Current state:**
- Albus UI not used in StringCost
- `ALBUS_BASEPATH` removed from documentation
- Control plane API is sufficient for credential management

---

## Updating Portkey Version

### Current Process

1. **Check for new Portkey releases:**
   ```bash
   cd vendor/portkey-gateway
   git fetch
   git log --oneline origin/main
   ```

2. **Test new version locally:**
   ```bash
   # Update PORTKEY_TAG with new commit hash
   echo "NEW_COMMIT_HASH" > PORTKEY_TAG

   # Rebuild gateway
   npm run build --workspace @stringcost/gateway

   # Run tests
   npm test --workspace @stringcost/gateway
   npm run smoke-test
   ```

3. **Review Portkey changelog:**
   - Check `vendor/portkey-gateway/CHANGELOG.md`
   - Look for breaking changes in provider adapters
   - Review middleware updates

4. **Update if needed:**
   ```bash
   cd vendor/portkey-gateway
   git checkout NEW_COMMIT_HASH
   cd ../..
   echo "NEW_COMMIT_HASH" > PORTKEY_TAG
   git add vendor/portkey-gateway PORTKEY_TAG
   git commit -m "Update Portkey to vX.Y.Z (commit: NEW_COMMIT_HASH)"
   ```

5. **Test thoroughly:**
   - Run full test suite
   - Test with multiple providers (OpenAI, Anthropic, Gemini)
   - Test streaming responses
   - Verify Docker builds

### Stability Considerations

**Why we pin to commit instead of version:**
- Portkey's npm package lags behind GitHub
- We want latest bug fixes without waiting for release
- Commit hash gives exact reproducibility

**When to update:**
- Security fixes (update immediately)
- New provider support (update when needed)
- Bug fixes (update quarterly)
- Feature additions (evaluate per feature)

**When NOT to update:**
- In middle of critical deployment
- Major version changes (requires testing)
- Breaking changes without migration plan

---

## Alternatives Considered

### Option 1: Use Portkey Hosted Service

**Approach:** Point requests to `api.portkey.ai`

**Pros:**
- No maintenance
- Automatic updates
- Managed infrastructure

**Cons:**
- ❌ External dependency (SLA risk)
- ❌ Cannot customize auth flow
- ❌ Additional network hop (latency)
- ❌ Cannot rebrand responses
- ❌ Vendor lock-in

**Decision:** Rejected

### Option 2: Fork Portkey

**Approach:** Fork Portkey repo and modify directly

**Pros:**
- Complete control
- Can modify Portkey internals

**Cons:**
- ❌ Must maintain fork indefinitely
- ❌ Cannot easily pull upstream updates
- ❌ Merge conflicts on updates
- ❌ Duplicate effort

**Decision:** Rejected

### Option 3: Self-Host Portkey as Separate Service

**Approach:** Deploy Portkey as separate container/service

**Pros:**
- Cleaner separation
- Easier to update Portkey

**Cons:**
- ❌ Network hop (latency)
- ❌ Still need auth wrapper
- ❌ Additional deployment complexity
- ❌ Cannot rebrand responses easily

**Decision:** Rejected

### Option 4: Build Our Own Gateway (No Portkey)

**Approach:** Implement provider integrations from scratch

**Pros:**
- Full control
- No external dependencies

**Cons:**
- ❌ Months of development time
- ❌ Maintaining 250+ provider integrations
- ❌ Debugging provider-specific issues
- ❌ Not battle-tested

**Decision:** Rejected - reinventing wheel

### ✅ Option 5: Vendor Portkey In-Process (Chosen)

**Approach:** Import Portkey source, wrap with custom auth

**Pros:**
- ✅ Zero network latency (in-process)
- ✅ Full control over auth
- ✅ Can rebrand responses
- ✅ Version stability (pinned commit)
- ✅ Access to source for debugging
- ✅ Battle-tested provider code

**Cons:**
- Manual updates (acceptable trade-off)
- Larger Docker image (~10MB more)

**Decision:** This is what we implemented.

---

## Known Limitations

### 1. Manual Updates Required

**Issue:** Must manually update Portkey version
**Impact:** May miss bug fixes or new providers
**Mitigation:** Quarterly update cadence, monitor Portkey releases

### 2. No Access to Portkey UI (Albus)

**Issue:** Portkey's UI for config management not used
**Impact:** Config management via API only
**Mitigation:** Control plane API provides equivalent functionality

### 3. Portkey Tests Skipped

**Issue:** `npm test` in `vendor/portkey-gateway/` skipped
**Impact:** Can't validate Portkey changes
**Mitigation:** Our integration tests cover critical paths

### 4. Larger Docker Images

**Issue:** Vendoring adds ~10MB to Docker images
**Impact:** Slower image pulls
**Mitigation:** Acceptable for control gained

---

## Security Considerations

### 1. Provider API Keys Never Exposed

**How:**
- Client never sends provider API key
- Control plane stores keys encrypted (pgcrypto)
- Gateway receives only `virtual_key` ID
- Portkey looks up actual key internally

**Result:** Client compromise doesn't leak provider keys

### 2. Signed URL Replay Protection

**How:**
- Nonce stored in PostgreSQL `signed_url_replays` table
- TTL = URL expiration time
- Second use of same nonce → 409 Conflict

**Result:** Stolen URLs can't be reused

### 3. Request Timeout

**How:**
- Gateway wraps Portkey call with 30-second timeout
- Prevents hanging requests

**Code:**
```typescript
const timeoutPromise = new Promise<Response>((_, reject) =>
  setTimeout(() => reject(new Error('Request to Portkey timed out')), 30000)
);
const response = await Promise.race([
  portkeyApp.fetch(forwardedRequest, env, executionCtx),
  timeoutPromise
]);
```

### 4. Rate Limiting

**How:**
- PostgreSQL-backed rate limiter
- 1000 requests/minute per client
- Applied before Portkey call

**Result:** Abuse prevention

---

## Performance Characteristics

### Latency Breakdown

| Stage | Latency | Notes |
|-------|---------|-------|
| TLS handshake | ~50ms | First request only |
| Signed URL verify | <1ms | HMAC + decrypt |
| Replay check | ~2ms | PostgreSQL query |
| Rate limit check | ~2ms | PostgreSQL query |
| Portkey routing | <1ms | In-process call |
| Provider API call | ~500ms | Network + LLM inference |
| Response rebrand | <1ms | Header/body replacement |
| **Total overhead** | **~6ms** | Excluding provider latency |

**Comparison to Hosted Portkey:**
- Hosted: +50ms for additional network hop to Portkey servers
- Vendored: +6ms (all in-process)
- **Result:** 8x faster overhead

### Memory Usage

| Component | Heap Usage | Notes |
|-----------|------------|-------|
| Hono wrapper | ~10MB | StringCost gateway wrapper |
| Portkey gateway | ~50MB | Vendored Portkey + providers |
| Provider configs | ~5MB | Cached provider metadata |
| Rate limit cache | ~10MB | PostgreSQL connection pool |
| **Total** | **~75MB** | Per gateway instance |

### Throughput

- **Tested:** 1000 req/s per gateway instance
- **Bottleneck:** Provider API rate limits, not gateway
- **Scaling:** Horizontal (add more gateway replicas)

---

## Monitoring & Observability

### Portkey-Specific Logs

**Debug logging:**
```bash
export DEBUG_GATEWAY_FORWARD=1
npm run dev --workspace @stringcost/gateway
```

**Output:**
```
Portkey response status 200
Portkey response body {"id":"chatcmpl-123",...}
```

### Headers for Tracing

**Portkey adds (then we rebrand):**
- `x-portkey-trace-id` → `x-stringcost-trace-id`
- `x-portkey-llm-provider` → `x-stringcost-llm-provider`
- `x-portkey-cache-status` → `x-stringcost-cache-status`

**StringCost adds:**
- `x-stringcost-run-id` - Client-provided run ID
- `x-stringcost-user-id` - Client-provided user ID
- `x-stringcost-scope` - Billing scope

### Recommended Metrics

1. **Portkey call duration** - Time spent in `portkeyApp.fetch()`
2. **Provider success rate** - 2xx vs 4xx/5xx from providers
3. **Portkey timeout rate** - How often 30s timeout triggers
4. **Response rebrand errors** - Failures in response adapter

---

## FAQ

### Why not use Portkey's SDK instead of vendoring?

**Answer:** Portkey's SDK is client-side. We need the gateway (server-side) for routing. The gateway isn't available as an npm package - it's designed for Cloudflare Workers deployment. Vendoring gives us access to the gateway code.

### Can we use Portkey's virtual keys feature?

**Answer:** Yes! We pass `x-portkey-virtual-key` header. However, we store our own credentials in `provider_credentials` table. Portkey's virtual key just acts as an ID.

### Does Portkey see our traffic/logs?

**Answer:** No. We vendor the code and run it ourselves. No data goes to Portkey servers.

### What if Portkey is discontinued?

**Answer:** We have the source code. We could fork and maintain if needed. But Portkey is MIT licensed and actively developed.

### How do we handle Portkey breaking changes?

**Answer:** We pin to specific commit. Only update when we explicitly test and validate.

### Can clients use Portkey-specific features?

**Answer:** Yes, via route config. Client requests signed URL with config, control plane encrypts it, gateway forwards to Portkey.

### Do we contribute back to Portkey?

**Answer:** Not yet. We could contribute provider fixes if we discover bugs.

---

## References

- **Portkey GitHub:** https://github.com/Portkey-AI/gateway
- **Portkey Docs:** https://portkey.ai/docs
- **Portkey Providers:** https://portkey.ai/docs/integrations/llms
- **Portkey Config Docs:** https://portkey.ai/docs/product/ai-gateway/configs
- **Portkey License:** MIT (see `vendor/portkey-gateway/LICENSE`)

---

## Maintenance Checklist

- [ ] **Quarterly:** Check for Portkey updates
- [ ] **Monthly:** Review Portkey security advisories
- [ ] **Per Update:** Run full test suite
- [ ] **Per Update:** Test multiple providers (OpenAI, Anthropic, Gemini)
- [ ] **Per Update:** Verify Docker builds
- [ ] **Per Update:** Update `PORTKEY_TAG` file
- [ ] **Per Update:** Document breaking changes in `agents.md`

---

*For StringCost architecture and service integration, see `README.md`*
*For deployment instructions, see `deploy/gke/DEPLOYMENT.md`*
*For project history and decisions, see `agents.md`*
