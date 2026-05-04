# Module A — Smaya Orchestrator (Walkthrough)

## What this module owns

The 14-stage mission state machine, the heartbeat loop, the gate machinery, the intent classifier, the depth/recursion guard, and the public intervention surface that the GraphQL API calls.

## File map

| File | Responsibility |
|---|---|
| `mission.ts` | The state machine. One `Mission` class instance per run. Owns the per-run mutable state (parsed candidates, R1/R2/R3 scores, phone outputs, intervention count). |
| `heartbeat.ts` | Stateful timer with drift + skip monitoring. Adaptive cadence keyed by stage. |
| `gates.ts` | Predefined `GATE_1` and `GATE_2` request/approve/reject + 4h timeout + non-bypass set. |
| `intent.ts` | Regex-first intent classifier for chat utterances. |
| `scoring.ts` | R1/R2/R3 scoring helpers using the LLM-agnostic interface. |
| `depth.ts` | Sub-orchestration depth ≤ 3 with circular detection. |
| `bus.ts` | In-process event bus (UI subscribes via SSE through the API). |
| `cli.ts` | Standalone runner. |

## Stage walkthrough

The mission proceeds via `Mission.run_()` which calls each stage in order inside a single `tracer.withSpan("mission.run", …)`. Every stage:

1. Calls `await this.transition("STAGE")` which writes the run record + emits a `STAGE_TRANSITION` audit event.
2. Calls `await this.checkPaused()` between async operations, so a pause request immediately drains in-flight work.
3. Routes any external call through an MCP tool (never direct SDK).

### 1. INGEST
Reads the resume directory, extracts `c\d+` ids from filenames, populates `run.candidateIds`. No external call.

### 2. PARSE
Pre-side-effect: `piiEval.run(...)` against the golden 5. If <100% mask rate, the stage throws — Cosmos write of any candidate is impossible without passing this eval.
Then issues an OAuth bearer token scoped to `resume:read` and calls `resumeParser` per candidate. The masked profile is persisted to `candidates`. Idempotency key is `mcp:resume-parser:${stableHash(runId, ["parse", id])}`.

### 3. SCORE_R1
`scoreR1` calls the LLM via the shared interface with `system: "SCORE_TASK_R1"`. The deterministic mock derives composite + dimensions from a hash of the prompt + a stable key (`R1:c01`). Persists to `evalResults` with `kind: "score"`.

### 4. GATE_1
Sets `run.status = "AWAITING_GATE"`, persists, calls `requestGate(runId, tenantId, "GATE_1")` — this writes a `GATE_REQUESTED` audit + emits `GATE_REQUESTED` on the bus. The orchestrator then `awaitGate("GATE_1")` which blocks on a bus listener for `GATE_APPROVED`. The Approvals tab in the UI calls `Mutation.approveGate(...)` to fire that event.

### 5. PHONE_SCREEN (with NUDGE retries)
Pre-side-effect: `scoreStabilityEval.run(...)` re-scores all R1 candidates with two independent LLM calls and confirms top-6 is identical. Throws if not.
Then for each candidate (excluding `goal.excludedCandidates`), calls `voiceCall` up to 3 times. On `NO_ANSWER` (deterministic for `c03` and `c09` on attempt 1), the stage transitions to `NUDGE`, sleeps `simToReal(nextRetryHintMs)`, and retries. Idempotency key includes the attempt number so each retry is its own write.

### 6. SCORE_R2
For each candidate that completed phone screen, calls `scoreR2` blending 70% LLM signal with 30% phone screen score. Persists.

### 7. AVATAR
For each R2 candidate, calls `avatarInterview` (deterministic 4-dimensional signal + red/green flags), then `scoreR3` blending 60% LLM with 40% interview avg. Persists R3 scores.

### 8. SCORE_R3
Fallback: if AVATAR was skipped via `DEVIATE` or all phone screens failed, R2 (or R1) is promoted into R3 slots so the leaderboard still has signal.

### 9. SEND_LEADERBOARD
Pre-side-effect: `biasEval.run(...)` against the bias golden. With N=10 candidates, the small-sample fallback (≥1 from each group) is sufficient.
Then posts to mock Slack via `slackPoster` and sends an email summary via `outlookScheduler`. Idempotency keys ensure that re-running this stage doesn't double-post.

### 10. GATE_2
Same machinery as GATE_1. Panel member confirms slot. The 4-hour simulated timeout (compressed by `SMAYA_COMPRESS_FACTOR`) is honored.

### 11. SCHEDULE_PANEL
Calls `outlookScheduler` with `op: "create-event"` for the top candidate, attendees = panel members + candidate identifier, with a 1-hour simulated slot starting 24h after gate approval. The event is recorded by the mock Outlook server and surfaced in the UI's Activity tab.

### 12. DECISION_PACK
Reads back evals, interventions, R3 scores. Composes the final `DecisionPack` (Zod-validated by `repos.putDecisionPack`). The Decision Pack contains:
- top-N leaderboard with rationale
- panel slot
- cost total
- duration ms
- per-eval pass/fail summary
- intervention count
- status (COMPLETED or ABORTED)

### 13. SELF_PAUSE
Final transition. Trace flush happens at e2e harness level (`tracer.snapshot()`).

## Heartbeat strategy

`Heartbeat.tick()`:
1. Reads wall-clock `now`.
2. Computes `driftMs = now - run.heartbeat.nextTickAt`. Drift > 30s emits `heartbeat.drift_alert`.
3. If `now - lastTickAt > expected × 2.5`, increments skipCount and emits `heartbeat.skip`.
4. Persists the new `nextTickAt` to Cosmos. **Resume-safe:** if the orchestrator process restarts mid-run, the next tick is reconciled from the persisted `nextTickAt`.
5. Calls the per-tick callback (the `Mission` softBudgetPause check).

Cadence:
- Active stages (PARSE, PHONE_SCREEN, NUDGE, AVATAR, SCORE_*, SEND_LEADERBOARD, SCHEDULE_PANEL, DECISION_PACK): 60s simulated.
- Passive stages (GATE_1, GATE_2 — waiting on a human): 5min simulated.

## Mid-flight intervention surface

The `Mission` class exposes 8 public methods called by the GraphQL resolver:

| Method | Behavior |
|---|---|
| `pause(reason, op)` | Sets `paused = true`, `status = PAUSED`, persists. Subsequent `checkPaused()` calls in the stage loop block on a queue of resume waiters. |
| `resume(op)` | Clears `paused`, releases all queued resume waiters. |
| `stop(op, reason)` | Sets `aborted = true`, releases waiters, audit-logs. The next `checkPaused()` throws "aborted by intervention" — the catch in `run_()` writes an ABORTED Decision Pack and emits `RUN_ABORTED`. |
| `addContext(text, op)` | Appends to context audit; the next stage that uses context picks it up. |
| `updateGoal(patch, op)` | Snapshots → applies → bumps `goalVersion` → writes a new `goalVersions` row → returns a goal diff. |
| `overrideRejectCandidate(id, op, rationale)` | Adds to `goal.excludedCandidates` AND filters out from the live R1/R2/R3 arrays so leaderboard re-ranks correctly. |
| `deviate(skipStage, op, rationale)` | Adds to `goal.skipStages`. The orchestrator checks this before AVATAR. |
| `replayAction(kind, candidateId, op)` | Re-runs the named action (currently `score`) with a fresh idempotency key, replacing the stale entry. |
| `status()` | Returns `{ stage, status, costUsd, etaSec }` for STATUS_QUERY chat. |

## Why each line is what it is

- `transition()` is its own function so every stage change is unambiguously audit-logged. Inlining it would create N audit-log call sites where one call site forgotten silently breaks rubric #14.
- `checkPaused()` returns a Promise that resolves when `resume()` releases the waiter — implementing pause as a queue (not a polling loop) avoids busy-waiting and keeps drift measurement accurate.
- Stage methods are all `private async` to prevent the GraphQL resolver from reaching past the public intervention surface.
- `aborted` and `paused` are separate flags because abort must take precedence over pause-resume cycles. A `stop` followed by a stale `resume` should not un-abort.
- `dialWithNudge` lives separately so the retry loop is fully visible — embedding it in `stagePHONE_SCREEN_with_NUDGE` would conflate the per-candidate retry semantics with the per-mission stage semantics.
- The fallback in `stageSCORE_R3` (promote R2 → R3 if AVATAR was skipped) is what lets `DEVIATE` work without leaving the mission in a state with no leaderboard signal.

## Critical invariants

1. **Every external call** goes through `@smaya/mcp-tools/wrap.ts:defineTool`. The orchestrator never directly imports `redis`, `@azure/cosmos`, or `pdfjs-dist`.
2. **Every stage transition** writes the run record before changing state, so a crash mid-stage replays correctly.
3. **Every Cosmos write** has a stable id derived from `(runId, candidateId, round)` or similar — replay-safe by primary key.
4. **No goal mutation** without confirmation (enforced at the API allow-list, but the Mission method is also private to the API resolver — UI cannot reach it directly).
5. **No gate bypass** is possible — even if the API allow-list missed it, the Mission has no public method to manually fire `GATE_APPROVED`. Gates are only resolved through the `gates.ts` `approveGate` function which always writes the `GATE_APPROVED` audit + bus event.
