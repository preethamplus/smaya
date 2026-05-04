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

# Or run a one-shot mission against the in-memory shims
npm run mission:run -- --in-memory --compress 60
```

UI: http://localhost:3000 · GraphQL: http://localhost:4000/graphql · Jaeger: http://localhost:16686

## Layout

| Package | Module | Purpose |
|---|---|---|
| `packages/shared` | — | Zod schemas, types, telemetry, cost ledger |
| `packages/data` | C | Cosmos DB client + in-memory shim + Redis idempotency |
| `packages/mcp-tools` | B | 5 MCP tools (resume-parser, voice-call, avatar-interview, slack-poster, outlook-scheduler) |
| `packages/evals` | — | Behavior evals + golden datasets |
| `packages/orchestrator` | A | 14-stage mission orchestrator with heartbeat + intervention layer |
| `packages/intervention-api` | E | GraphQL surface for chat-driven intervention |
| `packages/ui` | D | Next.js Activity / Approvals / Agent tabs |

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
