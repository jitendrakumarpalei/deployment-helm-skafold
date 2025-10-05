# Agent Playbook

Always read `SPEC.md` before authoring or updating agents. Treat it as the source of truth for architectural, billing, and deployment requirements.

This document explains how to build and operate agents inside the stringcost framework. Use it as the canonical reference for instrumenting agent logic, wiring MCP tools, and deploying compute surfaces that honor observability and billing guarantees.

## Implementation Plan

Use plan-mode to manage execution: create a plan that at minimum tracks the active phase, current deliverables, and validation checkpoints before you start coding. Keep `SPEC.md` and `GEMINI.md` open while you work, and update the plan as you finish each subtask.

### Phase 0 – Intake & Alignment
- **Objective:** Align on the problem statement, monetization targets, and impacted systems.
- **Primary Tasks:** Review `SPEC.md`, `GEMINI.md`, tickets, and stakeholder notes; document assumptions, dependencies, and affected surfaces; schedule design/product syncs if scope is ambiguous.
- **Deliverables:** Shared understanding of goals, risks, and billing levers captured in planning notes; updated plan-mode items covering downstream phases.
- **Exit Criteria:** Stakeholders agree on scope, KPIs, billing expectations, and delivery timeline.

### Phase 1 – Step Graph Architecture
- **Objective:** Translate requirements into an explicit reasoning and billing topology.
- **Primary Tasks:** Enumerate thoughts, tool uses, loops, and synthesis actions; define every `step` boundary, `actionType`, metadata (`unitCost`, token metrics, timers); map external interactions and required headers (`X-Parent-Trace-Id`).
- **Deliverables:** Reviewed diagram or document of the step graph; billing model per step; integration contracts for MCP servers and LLM providers.
- **Exit Criteria:** Architecture sign-off covering reasoning flow, observability nodes, and pricing hooks.

### Phase 2 – Tooling & Infrastructure Readiness
- **Objective:** Ensure supporting services, secrets, and build outputs can support the agent.
- **Primary Tasks:** Register/update MCP servers in `McpRegistry`; provision or mock new MCP handlers; verify Vercel AI SDK provider bindings, quotas, secrets; plan required `build.js` updates, routes, and cron schedules.
- **Deliverables:** Tooling endpoints reachable in development; documented environment variables; infra changes queued/approved.
- **Exit Criteria:** All external dependencies callable in dev/staging and reflected in the plan-mode tracker.

### Phase 3 – Agent Implementation
- **Objective:** Build the agent against framework primitives with readable control flow.
- **Primary Tasks:** Implement the async agent via `createAgent`; wrap each logical action in `step` according to the architecture; wire MCP helpers with `createMcpTool` and propagate trace headers; keep branching logic explicit (e.g., loops for tree-of-thought).
- **Deliverables:** Compiling agent module with exhaustive step coverage; minimal, purposeful inline comments; updated tests or harness placeholders.
- **Exit Criteria:** Code review-ready implementation with all planned steps present and names/types correct.

### Phase 4 – Billing & Telemetry Instrumentation
- **Objective:** Verify that metering and observability match the reasoning graph.
- **Primary Tasks:** Set `unitCost`, calculators, and custom metrics on each step; extend `BillingManager` if tiering or partner splits are needed; run scenario scripts (e.g., varying `branches` in `agents/coffee-name-agent.ts`) to confirm invoice scaling.
- **Deliverables:** Logs demonstrating trace IDs and billing events per step; sample invoices from `BillingManager.generateInvoice()`; updated dashboards or queries if applicable.
- **Exit Criteria:** Billing totals match forecasts, and observability tooling displays the new step graph without gaps.

### Phase 4.5 – Scenario Coverage (Examples)
- **Tree-of-thought agent:** Branch generation → expansion → evaluation → synthesis. Each branch and depth expansion must emit a separate `step` with correct `unitCost` and `quantity`. Our regression in `packages/framework/tests/billing.test.js` asserts that the invoice contains the root, per-branch expansion, per-branch evaluation, and final selection line items with the expected totals (`0.0155`).
- **Tool-augmented agent:** Demonstrated by the coffee name generator. The smoke test creates a scaffolded project, runs `node build.js`, and verifies the bundled API function plus static assets under `.vercel/output/`.
- **Backup validation:** Any new agent should include at least one automated test similar to the above, proving that billing metadata survives end-to-end execution.

### Phase 5 – Validation & Hardening
- **Objective:** Prove resilience for success and failure paths before shipping.
- **Primary Tasks:** Add focused unit/integration tests; exercise error cases (MCP outages, LLM timeouts, bad inputs) inside wrapped steps; perform peer reviews; capture refinements in `SPEC.md`.
- **Deliverables:** Passing test suite; documented failure handling; review feedback addressed.
- **Exit Criteria:** Quality bar met, sign-offs recorded, and plan-mode reflects readiness for packaging.

### Phase 6 – Packaging & Deployment
- **Objective:** Produce deployable artifacts and verify routing/build details.
- **Primary Tasks:** Run `node build.js`; inspect `.vercel/output` for expected function directories/configs; execute local smoke tests (Express harness hitting `.vercel/output/functions/*`); update `vercel.json` routes and crons; deploy with `vercel deploy --prebuilt` and monitor logs.
- **Deliverables:** Verified build output, documented deployment notes, updated environment configurations.
- **Exit Criteria:** Successful staging release with validated traces, invoices, and release checklist completed.

### Phase 7 – Post-Deployment Monitoring & Iteration
- **Objective:** Ensure production health and capture learnings for the roadmap.
- **Primary Tasks:** Monitor traces, billing totals, KPIs, and alerts; gather user feedback and analytics; log retro items for debt (refactors, test gaps, performance tuning).
- **Deliverables:** Monitoring dashboards or alert configs; retrospective notes; backlog tickets for follow-up work.
- **Exit Criteria:** Production run is stable, billing reconciles with forecasts, learnings documented, and plan-mode closed out.

## Core Concepts

- **Agent run** – Created with `createAgent(name, agentFn)`. It owns the root trace, lifecycle hooks, and a fresh, run-scoped `BillingManager`.
- **Step** – Declares an observable, billable unit of work. Wrap every meaningful operation in `step(options, workFn)` so that traces and invoices stay in sync.
- **BillingManager** – Aggregates step-level costs, logs events as they happen, and produces the final invoice once the agent resolves.
- **MCP tools** – External capabilities exposed through Managed Component Protocol servers. Register them in `McpRegistry` and hydrate them inside your agent with `createMcpTool`.

## Agent Lifecycle

1. `createAgent` builds an executor that accepts input and a scoped `step` helper.
2. Each `step` call creates a nested trace (for LangSmith) and emits a billable event with the supplied metadata.
3. The `BillingManager` records cost deltas per step and retains them for invoicing.
4. When the agent resolves, the framework ends the root trace and prints or returns the invoice so callers can persist or charge it.
5. Any MCP tool invocations propagate the parent trace ID and report their own metrics (duration, custom costs) back to the agent trace.

## Authoring Agents

- Model agent logic as a plain async function. Use loops, conditionals, and composition freely—they are captured by the tracing tree.
- Define clear `step` names and `actionType` values (`llm_call`, `tool_use`, `evaluation`, etc.) to keep observability dashboards meaningful.
- Provide `unitCost` (or other billing metadata) whenever the action should influence invoices.
- Handle errors inside `step` blocks so failures are attributed to the correct node in the trace.

### Using the Vercel AI SDK

- Prefer the SDK's low-level, single-shot helpers such as `generateText` or `streamText` with provider clients (`createOpenAI`, `createAnthropic`, ...).
- Avoid bundled abstractions (`generate` with tool orchestration, `streamUI`, etc.) because they hide sub-steps and break granular billing.
- Wrap **every** provider call inside a `step` so token usage and costs are recorded.

### Tree-of-Thought Example

- The runnable reference agent in `agents/coffee-name-agent.ts` synthesizes coffee shop names. It loops freely while every LLM call and evaluation remains wrapped in `step` for end-to-end tracing and flexible billing.
- The backing primitives in `lib/framework.ts` log trace boundaries and billing events (`BillingManager.record`) to the console. Running `index.ts` demonstrates how each `step` generates distinct trace IDs, cost events, and a final invoice.
- Supply `unitCost` for each branch evaluation and the synthesis step so the invoice mirrors the reasoning tree. Adjust the input `branches` count to see costs scale linearly with the breadth of the search.

### Dynamic Billing Scenario

Run `index.ts` twice—once with `branches: 3` and again with `branches: 5`.

- Each additional branch triggers another evaluation `step`, adding `$0.0010` (or whatever `unitCost` you set) to the invoice.
- The generated invoice shows the per-step line items followed by a total (for example, `$0.0080` for 3 branches vs. $0.0100 for 5 branches).
- This proves that billing is elastic by design: change the loop bounds or add new `step` types and the invoice automatically reflects the expanded work.

## Working With MCP Tools

- Register MCP servers once via the `McpRegistry` and expose them as callable tools with `createMcpTool`.
- Each MCP invocation includes the parent trace header (`X-Parent-Trace-Id`) so downstream services can spawn their own trace children.
- The build system wraps every MCP implementation with `@vercel/mcp-handler`, translating HTTP requests into MCP protocol calls, serving both JSON responses and SSE streams.
- Middleware in the MCP server measures execution time and returns it through `X-Execution-Time-Ms`, enabling dynamic, metric-based pricing.
- Treat MCP steps like any other tool call: wrap them in `step`, label them clearly, and map returned metrics into billing events.

## Packaging & Deployment

- Run `node build.js` to compile everything into the Vercel Build Output API layout under `.vercel/output/`.
- MCP sources (`src/mcp/**/*.mcp.ts`) are bundled into `mcp-*.func/` directories with streaming support and per-function configs.
- WebSocket sources (`src/websocket/**/*.ws.ts`) are wrapped into HTTP shims that expose REST endpoints and forward events to user-defined `onMessage` handlers.
- Cron sources (`src/cron/**/*.cron.ts`) are packaged with bearer-auth guards and long execution windows; pair them with `vercel.json.crons` schedules.
- Optional Next.js apps are built separately (`next build`) and copied into the same output tree so static assets and pages deploy alongside custom functions.
- `vercel.json` must point to the prebuilt output ("buildCommand": "node build.js", "outputDirectory": ".vercel/output") and declare cron schedules.
- Use `vercel deploy --prebuilt` to upload the generated output without re-running the build in Vercel.
- For local smoke tests, require the bundled function entrypoints from `.vercel/output/functions/*` inside an Express harness (see `test-local.js`).

## Billing & Observability

- Every `step` is both a trace node and a billing hook. Keep names/action types consistent for dashboards and invoices.
- Store derived metrics (token counts, execution time, API tier) on the billing event so usage plans can price flexibly.
- After `createAgent.invoke` completes, call `BillingManager.generateInvoice()` (or read its totals) to persist or charge the run.
- Surface streaming work (SSE responses from MCP functions) through dedicated steps so partial outputs remain attributable.

## Best Practices Checklist

- [ ] Wrap each meaningful operation in a `step` (including MCP calls, LLM invocations, and streaming updates).
- [ ] Supply `unitCost` or custom price calculators where applicable.
- [ ] Use descriptive `name` and `actionType` values for clarity.
- [ ] Keep Vercel AI SDK usage scoped to provider primitives inside steps.
- [ ] Propagate trace headers when calling external services or MCP handlers.
- [ ] Validate agent output and surface errors inside dedicated steps.
- [ ] Run `node build.js` before deploying so MCP/WebSocket/Cron wrappers stay in sync with the latest agent tooling.
- [ ] Confirm `vercel.json` routes and cron schedules match the generated functions.

By following this guide, every agent built on stringcost remains transparent, debuggable, and deployable on Vercel with full control over observability and billing.
