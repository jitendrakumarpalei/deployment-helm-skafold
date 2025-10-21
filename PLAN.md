# StringCost Security & Reliability Fixes - Critical Issues for Life-Critical Production

**Status**: 🚨 **BLOCKING - DO NOT DEPLOY TO PRODUCTION** 🚨

**Context**: This codebase was written by an unreliable developer and is scheduled for life-critical work. This document outlines all identified security vulnerabilities, reliability issues, and missing features that MUST be fixed before production deployment.

---

## 🔴 CRITICAL - Security Vulnerabilities (P0)

### 1. **Environment Variable Leakage in Logs**
**Severity**: CRITICAL
**Files**:
- `apps/control-plane/src/index.ts:4-6`
- `apps/event-collector/src/index.ts:4-6`

**Issue**: Both services dump ALL environment variables (including secrets, API keys, database URLs) to stdout on startup:
```typescript
console.log('=== ALL ENVIRONMENT VARIABLES ===');
console.log(JSON.stringify(process.env, null, 2));
console.log('=== END ENV ===');
```

**Risk**:
- Database credentials exposed in container logs
- API keys leaked to log aggregation systems
- Signing keys for URLs exposed
- Anyone with log access can compromise the entire system

**Fix Required**:
1. Remove ALL `console.log(JSON.stringify(process.env))` statements
2. Implement structured logging with explicit log levels
3. Add log sanitization to mask sensitive values
4. Review all log aggregation systems to ensure leaked secrets are purged

---

### 2. **Missing Rate Limiting - DoS Vulnerability**
**Severity**: CRITICAL
**Files**: All services (gateway, control-plane, event-collector)

**Issue**: ZERO rate limiting implemented anywhere in the system. An attacker can:
- Flood the presign endpoint to generate unlimited signed URLs
- Exhaust database connections
- Cause billing DoS by making unlimited LLM requests
- Overwhelm the classification worker queue

**Risk**:
- Complete service outage from resource exhaustion
- Unbounded cost escalation from LLM API abuse
- Database connection pool exhaustion
- Worker queue overflow

**Fix Required**:
1. Implement per-client rate limiting on all public endpoints:
   - `/control/v1/presign` - 100 req/min per API key
   - `/llm/*` - 1000 req/min per client
   - `/events` - 500 req/min per client
2. Add IP-based rate limiting for unauthenticated requests
3. Implement circuit breakers for downstream services
4. Add request size limits (body size < 10MB)
5. Add timeout protection on all HTTP requests
6. Monitor and alert on rate limit violations

---

### 3. **No Request Timeout Protection**
**Severity**: CRITICAL
**Files**:
- `apps/worker/src/classifier.ts:10-24`
- `apps/gateway/src/app.ts:104`
- All HTTP client calls

**Issue**: No timeout configuration on any HTTP requests. The classifier fetch and Portkey gateway calls have no timeout:
```typescript
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify(job),
  // NO TIMEOUT!
});
```

**Risk**:
- Worker threads hang indefinitely on slow classifier responses
- Gateway requests never complete, exhausting connection pools
- Cascading failures across services
- Resource leaks from hanging connections

**Fix Required**:
1. Add 30-second timeout to all fetch calls
2. Add retry logic with exponential backoff
3. Implement proper AbortController usage
4. Add connection pooling limits
5. Add circuit breaker pattern for failing external services

---

### 4. **Signed URL Replay Store Has Race Condition**
**Severity**: HIGH
**Files**: `apps/gateway/src/replayStore.ts:12-41`

**Issue**: The nonce check has a race condition. Between checking and inserting, two concurrent requests with the same nonce can both pass:
```typescript
// Line 17: DELETE is separate transaction
await pool.query('DELETE FROM signed_url_replays WHERE expires_at < NOW()');

// Line 18: INSERT happens later - RACE CONDITION HERE
const result = await pool.query(
  `INSERT INTO signed_url_replays (session_id, nonce, expires_at)
   VALUES ($1, $2, to_timestamp($3))
   ON CONFLICT DO NOTHING
   RETURNING 1`,
  [sessionId, nonce, expiresAt]
);
```

**Risk**:
- Replay attacks possible during high concurrency
- Multiple requests can use same signed URL
- Billing/audit trail corruption

**Fix Required**:
1. Wrap DELETE + INSERT in a single transaction
2. Use SELECT FOR UPDATE to lock during check
3. Add unit tests for concurrent replay attempts
4. Consider Redis for replay store (faster, better for high concurrency)

---

### 5. **Weak Input Validation on Critical Paths**
**Severity**: HIGH
**Files**:
- `apps/control-plane/src/server.ts:169-280`
- `apps/event-collector/src/server.ts:17-32`

**Issue**: Minimal validation on user inputs:
- No length limits on `path`, `metadata`, `run_id`, `user_id`
- No format validation on UUIDs
- No JSON schema validation on request bodies
- Metadata can contain arbitrary nested objects (potential NoSQL injection if stored in document DB)

**Risk**:
- Database DoS via huge JSON payloads
- Potential injection attacks
- Corrupt data in ledger
- Billing discrepancies

**Fix Required**:
1. Add JSON schema validation with `ajv` or `zod`
2. Enforce max length: path < 2048 chars, metadata < 64KB
3. Validate UUID format for run_id, user_id, session_id
4. Sanitize metadata to prevent nested object depth attacks
5. Add unit tests for malformed inputs

---

### 6. **Missing CORS Configuration**
**Severity**: MEDIUM
**Files**: All Hono apps

**Issue**: No CORS headers configured anywhere. In production:
- Web clients cannot call the API from browsers
- Or worse, CORS is disabled entirely, allowing any origin

**Risk**:
- XSS attacks from malicious websites
- Credential theft via CORS misconfiguration

**Fix Required**:
1. Add Hono CORS middleware with strict origin whitelist
2. Set `Access-Control-Allow-Credentials: false` (unless needed)
3. Specify exact allowed origins (no wildcards in production)
4. Add CORS preflight caching headers

---

### 7. **Database Connection Pool Exhaustion**
**Severity**: HIGH
**Files**:
- `apps/control-plane/src/db.ts:5-15`
- `apps/event-collector/src/db.ts:81-87`
- `apps/worker/src/worker.ts:23-28`

**Issue**: No connection pool limits configured. Default pg Pool has no max connections:
```typescript
pool = new Pool({ connectionString: url });
// NO max connections, no idle timeout, no connection timeout!
```

**Risk**:
- Database connection exhaustion under load
- "Too many connections" errors from Postgres
- Complete service outage when pool fills

**Fix Required**:
1. Set explicit pool limits:
   ```typescript
   new Pool({
     connectionString: url,
     max: 20,                    // max connections per service
     idleTimeoutMillis: 30000,   // close idle connections
     connectionTimeoutMillis: 5000,
   })
   ```
2. Different limits per service (worker needs fewer)
3. Add connection pool monitoring metrics
4. Implement graceful degradation when pool is full

---

### 8. **No SQL Injection Protection Verification**
**Severity**: MEDIUM
**Files**: All database query files

**Issue**: While parameterized queries are used (good!), there's no systematic verification. Some dynamic SQL risks:
- `apps/control-plane/src/server.ts:199-216` - Dynamic credential query construction
- No code review process to enforce parameterization

**Risk**:
- Future developer adds unsafe string concatenation
- SQL injection if someone "optimizes" queries

**Fix Required**:
1. Add ESLint rule to ban template literals in SQL queries
2. Add unit tests that attempt SQL injection on all endpoints
3. Use query builder like Knex for all dynamic queries
4. Add pre-commit hook to scan for unsafe SQL patterns

---

## 🟠 HIGH - Reliability Issues (P1)

### 9. **Missing Graceful Shutdown for Most Services**
**Severity**: HIGH
**Files**:
- `apps/gateway/src/server.ts` - NO SIGTERM handler
- `apps/control-plane/src/index.ts` - NO SIGTERM handler

**Issue**: Only `event-collector` and `worker` handle SIGTERM. Gateway and control-plane will:
- Drop in-flight requests on pod termination
- Leave database connections hanging
- Corrupt in-progress transactions

**Risk**:
- Data loss during deployments
- Failed requests during rolling updates
- Database connection leaks

**Fix Required**:
1. Add SIGTERM handler to gateway:
   ```typescript
   process.on('SIGTERM', async () => {
     console.log('SIGTERM received, closing connections...');
     // Close replay store pool
     // Wait for in-flight requests (set a deadline)
     process.exit(0);
   });
   ```
2. Add SIGTERM handler to control-plane (close db pool)
3. Add preStop hook in Kubernetes deployment (15 second delay)
4. Add connection draining period before exit
5. Test rolling updates don't drop requests

---

### 10. **Worker Job Failure Has No Dead Letter Queue**
**Severity**: HIGH
**Files**: `apps/worker/src/worker.ts:53-67`

**Issue**: When classification fails, jobs are just released back to the queue:
```typescript
catch (error) {
  console.error('Failed to classify job', job.log_id, error);
  await queue.release(job.job_id);  // Will retry infinitely!
}
```

No max retry limit. No dead letter queue. Jobs with permanently failing prompts will:
- Retry forever
- Block other jobs
- Waste classifier API quota

**Risk**:
- Worker stuck processing same failing jobs
- Queue starvation
- Cost escalation from repeated failures

**Fix Required**:
1. Add max retry count (attempts > 5 → move to DLQ)
2. Create `classification_jobs_failed` table
3. Move failed jobs to DLQ with error details
4. Add alerting for DLQ growth
5. Add admin endpoint to inspect/retry DLQ items

---

### 11. **No Health Check Endpoints Configured Properly**
**Severity**: MEDIUM
**Files**: `deploy/gke/helm/honojs-api/templates/deployment.yaml:53-66`

**Issue**: Health checks exist but not configured for all services correctly:
- Worker health check doesn't verify background worker is running
- No readiness vs liveness distinction
- Control-plane health check doesn't verify DB connectivity

**Risk**:
- Kubernetes routes traffic to unhealthy pods
- Failed database connections not detected
- Worker crashes not caught by health check

**Fix Required**:
1. Enhance `/healthz` endpoints:
   ```typescript
   app.get('/healthz', async (c) => {
     // Liveness: just alive
     return c.json({ status: 'ok' });
   });

   app.get('/readyz', async (c) => {
     // Readiness: check DB + dependencies
     try {
       await pool.query('SELECT 1');
       return c.json({ status: 'ready' });
     } catch (error) {
       return c.json({ status: 'not ready', error }, 503);
     }
   });
   ```
2. Update deployment.yaml to use separate liveness/readiness probes
3. Verify worker health check actually checks background loop

---

### 12. **Missing Database Migration Safety Checks**
**Severity**: MEDIUM
**Files**:
- `apps/control-plane/knex/migrations/20250101000000_initial_schema.js`
- `apps/ledger/knex/migrations/20250101000000_initial_schema.js`

**Issue**:
- No migration rollback testing
- No migration safety checks (breaking changes)
- No zero-downtime migration strategy
- Migrations use `notNullable()` which will fail if table has data

**Risk**:
- Broken deployments from failed migrations
- Data loss from untested rollbacks
- Downtime during schema changes

**Fix Required**:
1. Add migration safety checks:
   - Never add NOT NULL columns without default
   - Use multi-phase migrations for breaking changes
   - Add comment blocks explaining safety
2. Add migration testing in CI
3. Test rollback for every migration
4. Document zero-downtime migration procedures

---

### 13. **No Database Index Strategy**
**Severity**: MEDIUM
**Files**:
- `apps/ledger/knex/migrations/20250101000000_initial_schema.js:48-62`

**Issue**: Only one index on `ledger_events`:
```javascript
table.index(['run_id'], 'idx_ledger_events_run_id');
```

Queries by `user_id` (common for billing) will be slow. No composite indexes for common query patterns.

**Risk**:
- Slow queries as data grows
- Full table scans on large tables
- Poor performance for billing reports

**Fix Required**:
1. Add indexes:
   - `idx_ledger_events_user_id` on `user_id`
   - `idx_ledger_events_timestamp` on `timestamp DESC`
   - Composite: `(user_id, timestamp)` for time-range queries
2. Add index monitoring query to health check
3. Document query patterns and required indexes

---

### 14. **Classification Queue Has No Monitoring/Observability**
**Severity**: MEDIUM
**Files**: `apps/worker/src/queue.ts`

**Issue**: No metrics on:
- Queue depth
- Processing rate
- Failure rate
- Retry attempts distribution
- Job age

**Risk**:
- Cannot detect when queue is backing up
- No alerting on classifier failures
- No capacity planning data

**Fix Required**:
1. Add metrics endpoint (Prometheus format)
2. Expose queue depth metric
3. Add job processing duration histogram
4. Add failed jobs counter
5. Configure alerting on queue depth > 10000

---

## 🟡 MEDIUM - Missing Features (P2)

### 15. **No Audit Logging for Sensitive Operations**
**Severity**: MEDIUM
**Files**: All services

**Issue**: No audit trail for:
- API key usage (who called presign?)
- Provider credential changes
- Signed URL generation
- Admin operations

**Risk**:
- Cannot investigate security incidents
- No compliance trail
- Cannot track abuse

**Fix Required**:
1. Add audit_log table
2. Log all presign requests with client_id, timestamp
3. Log credential CRUD operations
4. Add retention policy (keep 90 days)
5. Make audit logs immutable (append-only)

---

### 16. **Missing Request ID Tracing**
**Severity**: MEDIUM
**Files**: All services

**Issue**: No request ID propagation across services. Cannot trace a request through:
- Gateway → Control plane → Event collector

**Risk**:
- Debugging is extremely difficult
- Cannot correlate logs across services
- Performance issues hard to diagnose

**Fix Required**:
1. Add Hono middleware to generate X-Request-ID
2. Propagate request ID to all downstream calls
3. Include request ID in all logs
4. Add request ID to error responses

---

### 17. **No Circuit Breaker for Classifier Service**
**Severity**: MEDIUM
**Files**: `apps/worker/src/classifier.ts`

**Issue**: Worker will hammer failing classifier endpoint infinitely.

**Risk**:
- DDoS on classifier when it's down
- Wasted API quota
- No fail-fast behavior

**Fix Required**:
1. Implement circuit breaker (e.g., `opossum` library)
2. Stop calling classifier after 5 failures in 60 seconds
3. Add half-open state to test recovery
4. Add metrics on circuit breaker state

---

### 18. **Signed URLs Have No Usage Tracking**
**Severity**: LOW
**Files**: `apps/gateway/src/app.ts`

**Issue**: Signed URLs can be used once, but no tracking of:
- How many were generated vs used
- Expiration without use (wastage)
- Failed validation attempts (attack detection)

**Risk**:
- Cannot detect abuse patterns
- No optimization of TTL settings
- No alerting on validation failures

**Fix Required**:
1. Track signed URL lifecycle in database
2. Record: created, used, failed_validation
3. Add metrics on usage rate
4. Add alerting on high validation failure rate

---

### 19. **No Kubernetes Resource Limits Tuning**
**Severity**: MEDIUM
**Files**: `deploy/gke/helm/honojs-api/templates/deployment.yaml:41-52`

**Issue**: Default resource limits are guesses:
```yaml
requests:
  cpu: 100m
  memory: 128Mi
limits:
  cpu: 200m
  memory: 256Mi
```

**Risk**:
- Pods OOMKilled under real load
- CPU throttling causes slow responses
- Overprovisioning wastes money

**Fix Required**:
1. Load test each service to determine real resource needs
2. Set requests = 80% of average usage
3. Set limits = 2x peak usage
4. Add HPA (Horizontal Pod Autoscaler) based on CPU/memory
5. Monitor actual resource usage vs limits

---

### 20. **Missing Secrets Rotation Strategy**
**Severity**: MEDIUM
**Files**: `apps/shared/src/signedUrl.ts:77-116`

**Issue**: URL_TOKEN_KEYS supports multiple keys (good!) but no docs on rotation:
- When to rotate?
- How to rotate without downtime?
- What happens to in-flight URLs?

**Risk**:
- Leaked keys remain valid forever
- Fear of rotation prevents security best practices
- Compliance issues (PCI-DSS requires rotation)

**Fix Required**:
1. Document key rotation procedure:
   - Add new key with different kid
   - Deploy with both keys active
   - Switch primary to new key
   - Wait for old TTL to expire (10 minutes)
   - Remove old key
2. Add automated rotation script
3. Add key age monitoring
4. Alert when key is > 90 days old

---

## 🟢 LOW - Code Quality Issues (P3)

### 21. **Inconsistent Error Handling**
**Severity**: LOW
**Files**: All services

**Issue**: Error responses are inconsistent:
- Some return `{ message: ... }`
- Some throw errors
- No standard error format

**Fix Required**:
1. Create standard error response format
2. Add global error handler middleware
3. Distinguish user errors (400s) from system errors (500s)
4. Never expose stack traces to clients

---

### 22. **No Input Sanitization for Logs**
**Severity**: LOW
**Files**: Multiple

**Issue**: User input logged directly:
```typescript
console.error('Control plane: invalid API key', apiKey);
```

**Risk**:
- Log injection attacks
- Sensitive data in logs

**Fix Required**:
1. Sanitize all user input before logging
2. Truncate long values
3. Mask API keys (show first 8 chars only)

---

### 23. **Missing API Versioning Strategy**
**Severity**: LOW
**Files**: All API endpoints

**Issue**: APIs have `/v1` and `/v2` but no documented versioning strategy.

**Fix Required**:
1. Document version deprecation policy
2. Add version header support
3. Add deprecation warnings for old versions

---

### 24. **No Dependency Vulnerability Scanning**
**Severity**: MEDIUM
**Files**: package.json files

**Issue**: No automated scanning for vulnerable dependencies.

**Fix Required**:
1. Add `npm audit` to CI pipeline
2. Fail builds on high/critical vulnerabilities
3. Set up Dependabot or Renovate
4. Regular dependency updates (monthly)

---

### 25. **Worker Doesn't Handle Classifier API Rate Limits**
**Severity**: MEDIUM
**Files**: `apps/worker/src/classifier.ts:10-24`

**Issue**: No handling of 429 (Too Many Requests) from classifier.

**Risk**:
- All jobs fail when hitting classifier rate limit
- No backoff strategy

**Fix Required**:
1. Detect 429 responses
2. Implement exponential backoff
3. Reduce batch size when rate limited
4. Add metrics on rate limit hits

---

## 📋 Implementation Priority

### Phase 0: BLOCKERS (Fix before ANY production deployment)
1. ✅ Remove environment variable logging (Issue #1)
2. ✅ Add rate limiting (Issue #2)
3. ✅ Add request timeouts (Issue #3)
4. ✅ Fix replay store race condition (Issue #4)
5. ✅ Add input validation (Issue #5)

### Phase 1: Critical Reliability (Fix in first week)
6. ✅ Add CORS configuration (Issue #6)
7. ✅ Configure database connection pools (Issue #7)
8. ✅ No SQL Injection Protection Verification (Issue #8)
9. ✅ Add graceful shutdown (Issue #9)
10. ✅ Implement dead letter queue (Issue #10)
11. ✅ Fix health checks (Issue #11)

### Phase 2: Production Hardening (Fix in first month)
11. ✅ Database migration safety (Issue #12)
12. ✅ Add database indexes (Issue #13)
13. ✅ Add monitoring/metrics (Issue #14)
14. ✅ Add audit logging (Issue #15)
15. ✅ Add request ID tracing (Issue #16)
16. ✅ Add circuit breakers (Issue #17)

### Phase 3: Operational Excellence (Ongoing)
17. ✅ Resource limits tuning (Issue #19)
18. ✅ Secrets rotation strategy (Issue #20)
19. ✅ Dependency scanning (Issue #24)
20. ✅ Rate limit handling in worker (Issue #25)

---

## 🧪 Testing Requirements

Before production deployment, ALL of the following tests MUST pass:

### Security Tests
- [ ] Penetration testing by third party
- [ ] SQL injection attempts on all endpoints
- [ ] XSS/CSRF vulnerability scan
- [ ] Secrets scanning (no credentials in logs)
- [ ] Rate limit bypass attempts
- [ ] Replay attack testing

### Reliability Tests
- [ ] Load test: 1000 req/sec for 1 hour
- [ ] Chaos testing: random pod kills
- [ ] Database failover testing
- [ ] Network partition testing
- [ ] Rolling update testing (zero dropped requests)
- [ ] Full disk simulation
- [ ] Worker queue backup/recovery

### Integration Tests
- [ ] End-to-end signed URL flow
- [ ] Multi-service tracing
- [ ] Database migration rollback
- [ ] Secrets rotation without downtime
- [ ] Graceful shutdown under load

---

## 📊 Acceptance Criteria for Production

### Security ✅
- [ ] Zero secrets in logs (verified by automated scan)
- [ ] All endpoints rate limited
- [ ] Request timeouts enforced
- [ ] Input validation 100% coverage
- [ ] CORS properly configured
- [ ] Security audit passed

### Reliability ✅
- [ ] 99.9% uptime over 2 weeks in staging
- [ ] Zero data loss during pod restarts
- [ ] Graceful degradation under 10x load
- [ ] All services have health checks
- [ ] Database migrations tested and rolled back

### Observability ✅
- [ ] Request tracing end-to-end
- [ ] All errors logged with context
- [ ] Metrics exported and monitored
- [ ] Alerts configured for critical issues
- [ ] Dashboards created for each service

### Documentation ✅
- [ ] Runbooks for common incidents
- [ ] Deployment procedures documented
- [ ] Secrets rotation guide
- [ ] Disaster recovery plan
- [ ] Capacity planning documentation

---

## 🚀 Next Steps

1. **Immediate**: Review this plan with team leads and security team
2. **Day 1-3**: Fix all Phase 0 blockers
3. **Week 1**: Fix all Phase 1 critical reliability issues
4. **Week 2-4**: Complete Phase 2 production hardening
5. **Week 4**: Run full test suite and security audit
6. **Week 5**: Deploy to production with monitoring

---

## 📞 Escalation

If ANY of the P0 (CRITICAL) issues cannot be fixed before the deployment deadline:

**DO NOT DEPLOY TO PRODUCTION**

Contact:
- Engineering Lead: [FILL IN]
- Security Team: [FILL IN]
- CTO: [FILL IN]

This system handles life-critical work. We cannot compromise on security or reliability.

---

**Document Version**: 1.0
**Created**: 2025-10-21
**Last Updated**: 2025-10-21
**Reviewed By**: Claude Code (Automated Security Review)
