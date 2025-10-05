# stringcost

**A framework for building, deploying, and monetizing AI agents with deep observability and usage-based billing.**

stringcost provides clean primitives for instrumenting agent logic—every LLM call, tool invocation, and reasoning step becomes both an observable trace node and a billable event. Write agents as standard async functions, deploy them as serverless functions on Vercel, and automatically track costs at the granularity you choose.

---

## Vision

Modern AI agents require:
- **Granular observability**: Track every decision, branch, and tool call
- **Flexible billing**: Charge based on actual work (tokens, tool calls, evaluation steps)
- **Developer experience**: Write readable async functions, not complex orchestration code

stringcost solves this by treating each `step` as both a trace node and a billing hook, giving you full control over observability and monetization without compromising code clarity.

---

## Architecture

### Core Primitives

**`createAgent(name, agentFn)`**
Wraps your agent logic, manages the root trace, and instantiates a per-run `BillingManager`.

**`step(options, workFn)`**
The fundamental building block. Each step:
- Creates a nested trace with unique ID
- Records billing metadata (`unitCost`, `quantity`, custom calculators)
- Handles errors and attributes them to the correct trace node
- Returns the result of `workFn` transparently

**`BillingManager`**
Aggregates costs from all steps and generates itemized invoices showing what work was done and what it cost.

**`createMcpTool(name)`**
Wraps MCP (Managed Component Protocol) servers as callable tools with automatic trace propagation and metric reporting.

### Design Philosophy

Inspired by:
- **Inngest**: Clean async function DX with explicit step boundaries
- **LangChain**: Tracing-first architecture for observability
- **À la carte pricing**: Bill for each action independently, not bundled workflows

Unlike high-level frameworks that hide sub-steps in black boxes, stringcost keeps every action explicit and individually metered.

---

## Repository Structure

```
stringcost/
├── packages/
│   ├── framework/              # Core primitives (@stringcost/framework)
│   │   ├── src/
│   │   │   ├── index.ts        # createAgent, step, BillingManager, McpRegistry
│   │   │   └── mock/           # Mock LLM helpers for testing
│   │   └── tests/              # Unit tests (billing, error handling, tree-of-thought)
│   ├── create-stringcost-app/  # CLI scaffolding tool
│   └── templates/              # Starter templates
├── apps/
│   └── web/                    # Next.js demo app
│       ├── lib/
│       │   ├── agents/         # Example: coffee name generator
│       │   └── mcp/            # Example: market trends MCP server
│       ├── pages/              # UI + API routes
│       ├── public/             # Static assets
│       └── server/             # Serverless handler wrappers
├── build.js                    # Vercel Build Output API v3 bundler
├── vercel.json                 # Deployment config
└── tests/                      # Smoke tests (CLI, build output)
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+ (workspaces support)

### Installation

```bash
npm install
```

This installs all workspace dependencies (framework, web app, CLI).

### Development

```bash
# Start Next.js dev server
npm run dev:web

# Build all packages
npm run build

# Run tests (unit + smoke)
npm test
```

### Test the Agent API

```bash
curl -X POST http://localhost:3000/api/agents/coffee \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Cozy downtown coffee shop","branches":3}'
```

Response includes:
- `output`: Agent results (themes, evaluations, synthesized names)
- `invoice`: Itemized billing with per-step costs and totals
- `traceId`: For correlating with observability systems

---

## Building Your First Agent

```typescript
import { createAgent } from '@stringcost/framework';

const myAgent = createAgent('myAgent', async (step, input) => {
  // Step 1: LLM call
  const analysis = await step(
    {
      name: 'Analyze Input',
      actionType: 'llm_call',
      unitCost: 0.002,
    },
    async (runtime) => {
      const result = await callLLM(input.prompt);
      runtime.recordMetadata({ tokens: result.tokenCount });
      return result.text;
    }
  );

  // Step 2: Tool use (with MCP)
  const marketData = await fetchMarketTrends(step, { category: input.category });

  // Step 3: Validation
  await step(
    {
      name: 'Validate Output',
      actionType: 'validation',
      unitCost: 0.0005,
      billOnError: true,
    },
    async () => {
      if (!isValid(analysis)) {
        throw new Error('Invalid analysis');
      }
    }
  );

  return { analysis, marketData };
});

// Invoke the agent
const result = await myAgent.invoke({ prompt: 'Example', category: 'coffee' });
console.log('Output:', result.output);
console.log('Invoice:', result.invoice);
```

### Key Features

- **Loops and branches** are just JavaScript—use `for`, `map`, conditionals freely
- **Dynamic billing**: Use `runtime.setQuantity()` or `runtime.setUnitCost()` to adjust costs based on actual work
- **Error attribution**: Failed steps are billed and traced separately
- **Custom calculators**: `costCalculator: ({ unitCost, quantity, metadata, durationMs }) => ...`

---

## MCP Tools

Register external services as MCP servers for automatic trace propagation and metric reporting:

```typescript
import { McpRegistry } from '@stringcost/framework';

McpRegistry.register({
  name: 'market-trends',
  description: 'Fetches market trend data',
  defaultUnitCost: 0.0005,
  async execute(input, context) {
    const start = Date.now();
    const data = await fetchTrends(input.category);
    const durationMs = Date.now() - start;

    return {
      result: data,
      unitCost: 0.0005,
      quantity: data.descriptors.length,
      metadata: { durationMs, region: input.region },
    };
  },
});
```

Use it in your agent:

```typescript
import { createMcpTool } from '@stringcost/framework';

const fetchMarketTrends = createMcpTool('market-trends');

const trends = await fetchMarketTrends(
  step,
  { category: 'coffee', region: 'global' },
  { name: 'Fetch Market Trends', actionType: 'tool_use' }
);
```

---

## Deployment (Vercel)

stringcost uses the **Vercel Build Output API v3** for prebuilt deployments.

### Build for Production

```bash
npm run build      # Build all packages
node build.js      # Generate .vercel/output/
```

This creates:
```
.vercel/output/
├── config.json                        # version: 3
├── static/                            # HTML, CSS, JS
└── functions/
    └── api/agents/coffee.func/
        ├── index.js                   # Bundled handler
        └── .vc-config.json            # runtime: nodejs18.x
```

### Deploy

```bash
vercel deploy --prebuilt
```

Vercel consumes the `.vercel/output/` directory as-is—no additional build step runs in the cloud.

### Validation

The build output is fully compatible with Vercel Build Output API v3:
- ✅ `config.json` with version 3
- ✅ Static files in `static/`
- ✅ Serverless functions in `.func` directories with proper `.vc-config.json`
- ✅ Node.js 18 runtime with valid handler exports

---

## Testing

### Unit Tests (Framework)

```bash
npm run test --workspace @stringcost/framework
```

Covers:
- Billing aggregation and sanitization (negative values, NaN, Infinity)
- Error handling and invoice propagation
- MCP tool metadata and cost overrides
- Tree-of-thought branching and per-step metering

**6/6 tests passing**, including edge cases for invalid numeric inputs.

### Smoke Tests (CLI + Build)

```bash
npm test
```

Scaffolds a fresh project via `create-stringcost-app`, runs `node build.js`, and validates:
- `.vercel/output/config.json` exists with version 3
- `functions/api/agents/coffee.func/` contains `index.js` and `.vc-config.json`
- `static/` contains HTML/CSS/JS assets

---

## Scaffolding New Projects

```bash
npx create-stringcost-app my-agent-project
cd my-agent-project
npm install
npm run dev
```

Includes:
- Next.js Pages Router app
- Pre-wired coffee name agent
- Serverless handler bundler
- Static landing page
- `build.js` for Vercel Build Output API v3

---

## Framework Package

### Installation

```bash
npm install @stringcost/framework
```

### Exports

```typescript
// Main exports
import {
  createAgent,
  BillingManager,
  createMcpTool,
  McpRegistry,
  AgentExecutionError,
  type StepFunction,
  type AgentContext,
  type BillingInvoice,
} from '@stringcost/framework';

// Mock LLM helpers (for testing)
import { generateThemes, evaluateTheme, synthesizeNames } from '@stringcost/framework/mock';
```

### Package Configuration

- ESM: `dist/index.mjs`
- CommonJS: `dist/index.js`
- Types: `dist/index.d.ts`
- Builds with `tsup` targeting ES2021

---

## Integration with Vercel AI SDK

Use the SDK's **single-shot functions** inside steps for LLM calls:

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const thought = await step(
  { name: 'Generate Thought', actionType: 'llm_call', unitCost: 0.003 },
  async (runtime) => {
    const { text, usage } = await generateText({
      model: openai('gpt-4-turbo'),
      prompt: 'What should I do next?',
    });
    runtime.recordMetadata({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    return text;
  }
);
```

**Avoid** high-level abstractions like `streamUI` or `generate` with tool orchestration—they bundle multiple steps into a black box, preventing granular billing.

---

## Example: Coffee Name Agent

The reference implementation (`apps/web/lib/agents/coffee.ts`) demonstrates:
- **Multi-step reasoning**: Generate themes → evaluate each → synthesize finalists
- **Dynamic billing**: Scale costs with branch count (3 branches = $0.011, 5 branches = $0.015)
- **MCP integration**: Optional market trends tool call
- **Error handling**: Validation step with duplicate detection

Run it:
```bash
curl -X POST http://localhost:3000/api/agents/coffee \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Mountain coffee roastery","branches":5,"finalists":3}'
```

Invoice breakdown:
1. Generate Name Themes: $0.002 × 5 themes = $0.010
2. Evaluate Theme (×5): $0.001 × 5 = $0.005
3. Synthesize Final Names: $0.002 × 3 = $0.006
4. Final QA Gate: $0.0005
5. Market Trends (optional): $0.0005 × 5 descriptors = $0.0025

**Total: $0.0240** (varies by input)

---

## Documentation

- **[SPEC.md](SPEC.md)**: Project vision, architecture, integration patterns
- **[AGENTS.md](AGENTS.md)**: Agent development playbook with 7-phase implementation plan
- **[claude.md](claude.md)**: Points to AGENTS.md for agent authoring guidance

---

## Fixes & Improvements (Latest)

Recent updates:
1. **TypeScript moduleResolution**: Changed to `Bundler` for proper `@stringcost/framework/mock` resolution
2. **Billing sanitization**: Negative values, NaN, and Infinity now sanitize to 0
3. **Package exports**: Added explicit `types` field for all module systems
4. **Test coverage**: Added edge case tests for invalid numeric inputs (6/6 passing)
5. **Vercel compatibility**: Validated Build Output API v3 structure (production-ready)

---

## Roadmap

- [ ] Publish `@stringcost/framework` to npm
- [ ] Add MCP handler bundling to `build.js` (currently manual)
- [ ] Streaming support for SSE-based tool responses
- [ ] WebSocket and Cron function wrappers
- [ ] Integration examples for OpenAI, Anthropic, Gemini
- [ ] Dashboard for viewing traces and invoices

---

## Contributing

See [AGENTS.md](AGENTS.md) for the 7-phase agent development workflow. All contributions should:
- Include tests (unit + smoke if applicable)
- Follow the step-based architecture
- Update documentation when adding features
- Validate Vercel Build Output API compatibility

---

## License

MIT

---

## Support

- **Issues**: [github.com/arakoodev/stringcost/issues](https://github.com/arakoodev/stringcost/issues)
- **Docs**: See SPEC.md and AGENTS.md in this repo
- **Examples**: `apps/web/lib/agents/coffee.ts`

Happy building! 🚀
