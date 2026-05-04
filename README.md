# Smaya — Autonomous AI Recruiting Agent

Implementation of **Smaya Assessment v5.0**: an autonomous, goal-driven, long-running recruiting agent that ingests resumes, scores candidates against a JD, runs phone-screen + avatar interview stages through MCP tools, surfaces 2 predefined human gates, accepts mid-flight chat intervention, and produces a Decision Pack.

> Zero external dependencies — runs end-to-end on a laptop with `docker compose up && npm run dev`, or with `--in-memory` shims if Docker is unavailable.

## Quick start

```bash
# 1. Install
npm install

# 2. (Optional) bring up Cosmos / Redis / Jaeger
docker compose up -d

# 3. Run the dev harness — orchestrator + intervention API + UI
npm run dev

# Or run a one-shot mission headless (in-memory by default)
npm run mission:run

# Or run a compressed-time E2E that fires 6 interventions and writes artifacts
SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs
```

UI: http://localhost:3000 · GraphQL: http://localhost:4000/graphql · Jaeger: http://localhost:16686

> Cosmos / Redis / Jaeger via Docker are optional. With nothing set, the system uses in-memory shims for storage + idempotency and an in-process span buffer for tracing. Set `SMAYA_COSMOS=1` or `SMAYA_REDIS=1` to opt into the real backends after `docker compose up -d`.

### Running with Azure Functions (Durable Functions)

The orchestrator can also run under Azure Functions Core Tools v4 using Durable Functions bindings.

**Prerequisites**: [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local) and [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) (Azure Storage emulator).

```bash
# Install prerequisites (if not already available)
npm install -g azure-functions-core-tools@4 --unsafe-perm true
npm install -g azurite

# Start Azurite in the background
azurite --silent &

# Build all packages and start the function host
npm run start:func
```

This builds the workspace and runs `func start --script-root packages/orchestrator`. The host discovers 18 functions (1 orchestrator, 1 HTTP trigger, 16 activities).

Start an orchestration via HTTP. The body must match the `MissionInput` shape in `packages/shared/src/schemas.ts`:

```bash
curl -X POST http://localhost:7071/api/orchestrators/missionOrchestrator \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "default",
    "goal": {
      "topN": 3,
      "jdId": "smaya-senior-backend-2026",
      "excludedCandidates": [],
      "skipStages": []
    },
    "resumesDir": "fixtures/resumes/pdf",
    "budgetUsd": 5
  }'
```

The response includes an `instanceId` and a status URL — poll the status URL until the orchestration shows `Completed`.

> `NODE_OPTIONS='--import tsx'` is set automatically by the script — workspace packages export `.ts` source files and the tsx loader handles them at runtime. On Windows, run the command from git-bash or WSL (cmd.exe doesn't parse the env-var prefix syntax).

## Layout

| Package | Module | Purpose |
|---|---|---|
| `packages/shared` | — | Zod schemas, types, telemetry, cost ledger |
| `packages/data` | C | Cosmos DB client + in-memory shim + Redis idempotency |
| `packages/mcp-tools` | B | 5 MCP tools (resume-parser, voice-call, avatar-interview, slack-poster, outlook-scheduler) |
| `packages/evals` | — | Behavior evals + golden datasets |
| `packages/orchestrator` | A | 14-stage mission orchestrator with heartbeat + intervention layer |
| `packages/intervention-api` | E | GraphQL surface for chat-driven intervention |
| `packages/ui` | D | Vite + React Activity / Approvals / Agent tabs |

## Docs

**For users**
- [`docs/USAGE.md`](./docs/USAGE.md) — install, run, configure, step-by-step demo flow
- [`docs/FEATURES.md`](./docs/FEATURES.md) — what the system does, organized by capability
- [`docs/TESTING.md`](./docs/TESTING.md) — verification matrix per non-negotiable, scenario tests, troubleshooting

**For reviewers**
- [`plan.md`](./plan.md) — strategy, LLM choice, sequencing, trade-offs
- [`docs/MODULE_A_WALKTHROUGH.md`](./docs/MODULE_A_WALKTHROUGH.md) — orchestrator
- [`docs/MODULE_B_WALKTHROUGH.md`](./docs/MODULE_B_WALKTHROUGH.md) — MCP tools
- [`docs/MODULE_C_WALKTHROUGH.md`](./docs/MODULE_C_WALKTHROUGH.md) — Cosmos + idempotency
- [`docs/MODULE_D_WALKTHROUGH.md`](./docs/MODULE_D_WALKTHROUGH.md) — UI
- [`docs/MODULE_E_WALKTHROUGH.md`](./docs/MODULE_E_WALKTHROUGH.md) — intervention API
- [`docs/AI_RETRO.md`](./docs/AI_RETRO.md) — "where AI got it wrong, what I did"
- [`docs/NON_NEGOTIABLES.md`](./docs/NON_NEGOTIABLES.md) — clause-by-clause map of the 17 non-negotiables to code paths

## Rubric coverage

See [`docs/NON_NEGOTIABLES.md`](./docs/NON_NEGOTIABLES.md) for a clause-by-clause map. See [`docs/TESTING.md`](./docs/TESTING.md) for how to verify each one.

## AI tools used

Per spec §8 (Required AI Tool Usage):

| Tool | Required for | Used for | Evidence |
|---|---|---|---|
| **Claude Code** | Modules A, C, E | Modules A–E foundation, mission state machine, intervention API, walkthrough docs, E2E harness | Commit history on `pr/01` through `pr/05` |
| **Devin** | Module B + E2E test | Azure Functions Core Tools v4 + Durable Functions bindings (PR #6); validated `func start` discovers all 18 functions | [Devin session](https://app.devin.ai/sessions/490dc225f805497abf5503d04abff300) · [PR #6](https://github.com/preethamplus/smaya/pull/6) |
| **Codex** | Test fixtures or Module D scaffold | _not yet used_ | — |
| **Vercel v0 / Lovable** | Module D UI | _not yet used; UI is hand-rolled in Vite + React. Integration code (GraphQL fetch + SSE + intent classifier) is the part the candidate owns regardless of generator._ | — |

## Demo

E2E demo video showing the full mission run + 6 mid-flight interventions:

> _Video link to be added once recorded. See [`docs/USAGE.md`](./docs/USAGE.md) §5 for the 13-step flow that the recording follows._

For a faster headless verification, run `SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs` — it produces a sample run with 6 audited interventions in under 2 seconds. Sample artifacts are committed at [`artifacts/runs/sample/`](./artifacts/runs/sample).
