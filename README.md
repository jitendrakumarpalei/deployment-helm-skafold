# stringcost Monorepo

Comprehensive reference implementation of the stringcost agent framework, a Next.js demo application, and the `create-stringcost-app` scaffolding CLI. The repo is organised as an npm workspace so everything builds, tests, and deploys together.

## Repository Layout

```
apps/
  web/                        # Next.js demo (Pages Router)
    pages/                    # UI + API routes (coffee agent example)
    public/                   # Static UI served via .vercel/output/static
    server/                   # Shared agent invocation + serverless handler entry
packages/
  framework/                  # Core step/billing primitives (bundled via tsup)
  create-stringcost-app/      # CLI for scaffolding a new project
  templates/next-app/         # Template files copied by the CLI
build.js                      # Root build script -> .vercel/output
vercel.json                   # Prebuilt-deploy configuration
```

## Prerequisites

- Node.js 18 or newer
- npm 9 or newer (workspaces support)
- No additional global installs are required. The repo manages `tsup`, `esbuild`, etc. locally.

## Bootstrapping the Monorepo

```bash
npm install
```

This installs dependencies for the root and every workspace (`apps/web`, `packages/framework`, `packages/create-stringcost-app`).

## Day-to-day Commands

| Command | Description |
| --- | --- |
| `npm run dev:web` | Runs the Next.js dev server (Pages Router) on port 3000. |
| `npm run build` | Builds every workspace (framework via tsup, CLI via tsc, Next.js via `next build`). |
| `npm run test` | Runs framework tests **and** a CLI smoke test that scaffolds a project, runs its build, and confirms `.vercel/output`. |
| `node build.js` | Packages the project into the Vercel Build Output API format under `.vercel/output/`. |

## Working with the Next.js Demo (`apps/web`)

- UI lives in `pages/index.tsx` (Pages Router for wider compatibility).
- API route `pages/api/agents/coffee.ts` invokes the shared agent logic in `server/coffee-invoke.ts`.
- A serverless-friendly wrapper (`server/coffee-handler.ts`) is bundled for Vercel so the same agent logic runs in `.vercel/output/functions/api/agents/coffee.func/index.js`.
- Static HTML/CSS/JS resides in `public/` – after a build it’s copied to `.vercel/output/static/`.

## Building the Framework Package

The core library exports `createAgent`, `step`, `BillingManager`, and MCP integration helpers. It targets both ESM and CommonJS via `tsup`.

```bash
npm run build --workspace @stringcost/framework
```

Outputs: `packages/framework/dist/index.{js,mjs,d.ts}` plus the mock LLM helpers in `dist/mock/`.

## Scaffolding with the CLI

The `create-stringcost-app` package ships a template matching this repository. After running `npm install`:

```bash
npx create-stringcost-app my-agent-project --install
```

What you get:
- Next.js Pages Router app wired to `@stringcost/framework`
- API route and serverless handler bundler (`server/coffee-handler.ts`)
- Static landing page in `public/`
- A `build.js` identical to this repo’s version, producing `.vercel/output` for deployment

## Producing Vercel Build Output

To prepare a prebuilt deployment run:

```bash
npm run build             # optional but recommended (builds all workspaces)
node build.js             # creates .vercel/output
```

`build.js` performs the following:

1. Runs `npm run build --workspace web` (helpful for local parity; the script keeps going even if the sandbox blocks parts of the build).
2. Clears `.vercel/output/` and recreates the required structure.
3. Copies everything from `apps/web/public/` into `.vercel/output/static/`.
4. Bundles `apps/web/server/coffee-handler.ts` with `esbuild` into `.vercel/output/functions/api/agents/coffee.func/index.js` and writes the accompanying `.vc-config.json` pointing at the Node.js 18 runtime.
5. Writes `.vercel/output/config.json` with `version: 3`.

Resulting tree (after the smoke test or `node build.js`):

```
.vercel/output/
  config.json
  static/
    index.html
    main.js
    style.css
  functions/
    api/agents/coffee.func/
      index.js
      .vc-config.json
```

This is the exact layout `vercel deploy --prebuilt` expects.

> ℹ️ Note: In this sandbox environment Next.js cannot emit `.next/standalone` because sockets/IPC calls are blocked. The build script therefore bundles the Node handler manually so deployment stays reliable. On your own machine or in CI the same script still works – it just skips copying `.next/standalone` and relies on the esbuild bundle.

## Deploying to Vercel

1. Make sure `.vercel/project.json` exists (or run `vercel` once to link the project).
2. Produce build output: `npm run build && node build.js`
3. Deploy: `vercel deploy --prebuilt`

Vercel will consume the `.vercel/output/` directory as-is, so no additional build step runs in the cloud.

## Testing & Validation

- `npm run test --workspace @stringcost/framework` executes Node-based unit tests covering billing, error attribution, and a *tree-of-thought* scenario that ensures each branch is individually metered.
- `npm run test` first runs all workspace scripts, then a **CLI smoke test** that scaffolds a fresh project, links the local framework, runs `node build.js`, and asserts the expected `.vercel/output` structure.
- You can manually hit the agent API after `npm run dev:web` via `curl`:

  ```bash
  curl -X POST http://localhost:3000/api/agents/coffee \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"Name ideas for a waterfront cafe"}'
  ```

  The response includes both the generated output and the invoice line items recorded by `BillingManager`.

## Template Maintenance

The CLI template (`packages/templates/next-app`) mirrors the live project:
- Pages Router entry point (`pages/_app.tsx`, `pages/index.tsx`)
- API route + serverless handler identical to `apps/web`
- Static landing page in `public/`
- Styles and script assets
- Shared `build.js`

When you update the main project, copy over changes so newly scaffolded apps stay in sync.

## Troubleshooting

- **`next build` fails with `listen EPERM` (sandbox only):** The script already catches this and continues. The prebuilt bundle still works.
- **Missing `.vercel/output/functions/...`:** Make sure `node build.js` ran after `npm run build` and that `apps/web/server/coffee-handler.ts` exists.
- **Custom agents/tools:** Extend `apps/web/server/coffee-invoke.ts` (and the template equivalent) to export additional handlers, then update `build.js` to bundle them into discrete functions.

## Next Steps

- Package MCP handlers alongside the coffee agent in `build.js`.
- Add CLI smoke tests that scaffold a sample app, run its build, and ensure `.vercel/output` exists.
- Integrate provider SDKs (OpenAI, Vercel AI SDK) now that the framework package structure is in place.
- Consider publishing `@stringcost/framework` to npm for reuse beyond this repo.

Happy building! If you run into rough edges, update `build.js`, the template, and the docs together to keep everything aligned.
