# Build Log — Smaya v5.0

A chronological log of every major change. Updated as work proceeds.

## Step 1 — Repo scaffold (PR-00)

**What:** Created `D:\test\smaya` monorepo with npm workspaces.

**Files created:**
- `package.json` — workspaces root, scripts (`dev`, `mission:run`, `evals:run`)
- `tsconfig.base.json` + `tsconfig.json` — strict TS, project references
- `.gitignore`
- `docker-compose.yml` — Cosmos emulator, Redis, Jaeger (optional, all replaceable by in-memory shims)
- `README.md` — quick start, layout, doc map
- `plan.md` — LLM choice (deterministic mock), sequencing, state machine, guardrails table, "AI got it wrong" running notes
- `BUILD_LOG.md` — this file

**Workspace skeleton (empty so far):**
- `packages/shared` — Zod schemas, telemetry, cost ledger
- `packages/data` — Cosmos client + Redis idempotency
- `packages/mcp-tools` — 5 MCP tools
- `packages/evals` — behavior evals
- `packages/orchestrator` — 14-stage mission
- `packages/intervention-api` — GraphQL
- `packages/ui` — Next.js (Activity / Approvals / Agent)

**Decision points:**
- LLM = deterministic mock (stub keyed by hash of prompt). Anthropic + Ollama paths wired but disabled by default. Rationale documented in `plan.md` §1.
- Cosmos + Redis run in Docker; the codebase also accepts `--in-memory` for reviewers without Docker.
- 5 PR branches planned (`pr/00-scaffold` through `pr/05-module-d-ui`).

**Next:** generate synthetic resumes + JD; build `packages/shared`.
