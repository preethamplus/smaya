# Features

What the system does, organized by capability.

## Mission orchestration (Module A)

- **14-stage mission state machine** — INGEST → PARSE → SCORE_R1 → GATE_1 → PHONE_SCREEN+NUDGE → SCORE_R2 → AVATAR → SCORE_R3 → SEND_LEADERBOARD → GATE_2 → SCHEDULE_PANEL → DECISION_PACK → SELF_PAUSE.
- **Resume-safe** — every stage transition writes the `RunRecord` to Cosmos before changing state. A mid-flight crash recovers from the persisted checkpoint, not memory.
- **Adaptive heartbeat** — 60s simulated cadence during active stages, 5min during human-gate waits. Drift measured against wall-clock, alerts at >30s, skip detection at >2.5× cadence.
- **Sub-orchestration depth limit** — depth ≤ 3 enforced at register-time with circular detection.
- **Time compression** — `SMAYA_COMPRESS_FACTOR` collapses simulated time uniformly. Drift logic always uses real wall-clock so cadence correctness is genuine.

## MCP tools (Module B)

Five tools, all routed through one `defineTool` wrapper that enforces:

1. Gate-clearance flag (no external call without prior gate clearance per spec §5.3).
2. OAuth 2.1 stub bearer-token validation.
3. Zod input + output schema validation.
4. Idempotency lookup (24h TTL).
5. mcpCallLog write.
6. Cost ledger entry (only on first execution).
7. Telemetry span.

| Tool | Type | Notes |
|---|---|---|
| `resume-parser` | Real | pdfjs-dist text extraction; SHA-256 token PII masking; `assertNoPII` defense-in-depth |
| `voice-call` | Stub | Deterministic; NO_ANSWER for c03/c09 first attempt → exercises NUDGE path |
| `avatar-interview` | Stub | 4-dimension signal + red/green flags |
| `slack-poster` | HTTP → mock | POSTs to local mock Slack server (port 5101) |
| `outlook-scheduler` | HTTP → mock | POSTs to local mock Outlook server (port 5102), supports `send-email` and `create-event` |

## Data layer (Module C)

- **9 Cosmos containers**, all partitioned by `/tenantId`:
  - `agentRuns`, `decisionPacks`, `auditLog`, `mcpCallLog`, `costLedger`, `evalResults`, `candidates`, `goalVersions`, `interventions`
- **Two backends behind one `Store` interface**: `InMemoryStore` (default, no Docker required) and `CosmosStore` (lazy-loaded `@azure/cosmos` when `SMAYA_COSMOS=1`).
- **Typed `Repos`** — Zod parse on every read AND every write. A corrupted item cannot be persisted; the schema fails closed.
- **PII assertion** at the data-write boundary on the `candidates` container. Decision packs intentionally include panel-member emails and are not gated.
- **Redis-backed idempotency** with 24h TTL. In-memory fallback when `SMAYA_REDIS` is unset.

## Behavior evals

Three evals, all **pre-side-effect** (orchestrator gates the side effect on `eval.passed`):

| Eval | Gates | Threshold | Golden dataset |
|---|---|---|---|
| `PII_MASKING` | First Cosmos write of parsed resume | 100% mask rate on golden 5 | `fixtures/golden/pii-golden.json` |
| `SCORE_STABILITY` | Phone-screen dial-out | top-6 stable across 2 model runs | self-consistent (no file) |
| `LEADERBOARD_BIAS` | Slack/email send | demographic parity 0.8–1.25, with small-sample fallback for N<20 | `fixtures/golden/bias-golden.json` |

Every eval result is persisted to `evalResults` and emitted to the trace.

## Human gates

- **Exactly 2 predefined gates**: `GATE_1` after R1 scoring (recruiter approves dial-out); `GATE_2` after leaderboard send (panel confirms slot).
- **4-hour simulated timeout** with escalation logged to audit.
- **Non-bypassable** — the intervention API allow-list refuses `OVERRIDE_DECISION { kind: skip_gate }` before any other validation.

## Mid-flight intervention

Five primitives via the GraphQL `interveneRun` mutation:

| Intent | Behavior |
|---|---|
| `STATUS_QUERY` | Returns stage / status / cost / ETA |
| `ADD_CONTEXT` | Injects context into the plan layer; versioned in audit |
| `UPDATE_GOAL` | Snapshot → diff → confirm → re-plan → audit. Bumps `goalVersion`, writes to `goalVersions` container |
| `PAUSE` | Sets `paused = true`; subsequent stage iterations block on a queue (no busy-wait); drains in-flight MCP calls |
| `RESUME` | Releases the queue; restarts from Cosmos checkpoint |
| `STOP` | Hard abort — cancels sub-orchestrations, writes ABORTED Decision Pack, non-resumable |
| `OVERRIDE_DECISION` | Reject candidate (rationale required); skip-gate refused with documented reason |
| `REPLAY_ACTION` | Re-runs a named action (currently `score`) with fresh idempotency key |
| `DEVIATE` | Adds a stage to `goal.skipStages`; orchestrator honors before that stage |

**Every accepted AND refused intervention** writes to `interventions` AND `auditLog` with operator identity and rationale.

**Confirmation flow** required for: `UPDATE_GOAL`, `OVERRIDE_DECISION`, `DEVIATE`, `STOP`. The first call returns a diff preview; the second call with `confirmed: true` applies.

## GraphQL API (Module E)

- Endpoint: `POST /graphql` (graphql-yoga).
- SSE endpoint: `GET /events` — streams `bus` events. Used by the UI for live updates.
- Schema matches spec §7 verbatim, plus query helpers (`runs`, `run`, `audit`, `interventions`, `decisionPack`, `slackMessages`, `outlookEmails`, `outlookEvents`) and the `startMission` mutation for boot-from-UI.
- Allow-list (`packages/intervention-api/src/allowlist.ts`) is the single source of truth for what an operator may do.

## Operator UI (Module D)

Three tabs at http://localhost:3000:

- **Activity** — live timeline of run events (SSE), latest mock Slack post, latest mock Outlook email + calendar event, full Decision Pack JSON.
- **Approvals** — pending gates with Approve/Reject buttons, operator email captured for audit.
- **Agent** — chat panel with regex intent classifier (UX hint, server is authoritative), confirmation flow with diff preview, refusal UX (red border + reason verbatim), inline diff display, audit-id breadcrumb on every reply.

## Observability

- **In-process tracer** at `packages/shared/src/telemetry.ts`. Every MCP call wraps in a `mcp.<name>` span. Heartbeat events emit `heartbeat.drift_alert` and `heartbeat.skip`.
- **Trace snapshot** dumped to `artifacts/runs/<runId>/trace.json`.
- **OTel-shaped** but framework-free — drop in `@opentelemetry/sdk-node` if you want to ship to Jaeger; the spans are structured to map cleanly.

## Cost guardrails

- Per-mission $5 cap (configurable via `SMAYA_BUDGET_USD`).
- Soft-cap at 80% triggers `softBudgetPause` from the heartbeat tick.
- `costLedger.add(...)` called once per successful MCP execution (replays do not double-charge).
- All cost rows persist to the `costLedger` Cosmos container with `(source, usd, at)` and the `runId`.

## LLM-agnostic interface

`packages/shared/src/llm.ts` exposes one `LLMClient` interface with three implementations:

- `DeterministicMockLLM` — default; outputs derived from SHA-256 of `(system, prompt, stableKey)`. Score-stability eval passes by construction in mock mode.
- `AnthropicLLM` — lazy-loads `@anthropic-ai/sdk`; uses Haiku 4.5 by default; cost computed from token usage.
- `OllamaLLM` — uses fetch against `OLLAMA_URL`; cost = 0.

The orchestrator imports the `LLMClient` interface, never a concrete impl. Behavior evals work in all three modes.

## Audit + compliance

- **Append-only audit log** with 9 entry types: STAGE_TRANSITION, GATE_REQUESTED, GATE_APPROVED, GATE_REJECTED, INTERVENTION, MCP_CALL, EVAL_RESULT, BUDGET_PAUSE, ERROR.
- **Operator identity + rationale** required on the OVERRIDE_DECISION + DEVIATE paths.
- **Schema-pinned Decision Pack** — `Zod.parse` runs before write; reviewers can validate the artifact independently.

## Local-first / zero external dependencies

The system runs end-to-end on a laptop with no cloud account, no API key, no inbound network access:

- LLM: deterministic mock by default.
- Slack: local mock HTTP server.
- Outlook / Microsoft Graph: local mock HTTP server.
- Cosmos: in-memory shim (or emulator via Docker).
- Redis: in-memory shim (or emulator via Docker).
- Resume parsing: real PDF extraction via `pdfjs-dist` (vendored).
