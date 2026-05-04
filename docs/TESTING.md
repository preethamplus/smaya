# Testing

How to verify each non-negotiable holds, what to look for, and where the evidence lives.

## Quick smoke test (1 minute)

```bash
SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs
```

Expected output (last 15 lines or so):

```
[e2e] mission <uuid> starting (compress=600)
[e2e] intent=STATUS_QUERY accepted=true requiresConfirm=false reason=
[e2e] intent=ADD_CONTEXT accepted=true requiresConfirm=false reason=
[e2e] intent=UPDATE_GOAL accepted=false requiresConfirm=true reason=confirmation required
[e2e] intent=UPDATE_GOAL confirm=true
[e2e] intent=OVERRIDE_DECISION accepted=false requiresConfirm=false reason=Predefined gates are non-bypassable. Use the Approvals tab to approve normally.
[e2e] intent=REPLAY_ACTION accepted=true requiresConfirm=false reason=
[e2e] intent=OVERRIDE_DECISION accepted=false requiresConfirm=true reason=confirmation required
[e2e] intent=OVERRIDE_DECISION confirm=true
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\run-record.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\decision-pack.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\audit.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\interventions.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\mcp-calls.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\evals.json
[e2e] wrote D:\test\smaya\artifacts\runs\<uuid>\trace.json
```

If you see all 7 file writes and a refusal on `skip_gate`, the system is healthy.

## Non-negotiables — verification matrix

Every row maps a rubric item to a concrete check.

| # | Non-Negotiable | How to verify | Evidence file |
|---|---|---|---|
| 1 | One-command boot | `npm run dev` brings up mocks + API + UI in <30s | terminal output |
| 2 | Zero requests to Exterview | Run with no env vars set; mission completes | `artifacts/runs/sample/decision-pack.json` |
| 3 | Compressed window completion | `SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs` finishes in <2s wall | `run-record.json:durationMs` |
| 4 | Heartbeat drift + skip monitoring | Search trace for `heartbeat.drift_alert` or `heartbeat.skip` | `trace.json` |
| 5 | 3 pre-side-effect evals with golden | `evals.json` has 3 entries with `passed: true` | `evals.json` |
| 6 | Budget cap auto-pause at 80% | Set `SMAYA_BUDGET_USD=0.05` and observe `BUDGET_PAUSE` audit | `audit.json` |
| 7 | Zod on every MCP I/O | Send a malformed payload via curl to `/graphql` interveneRun | error response |
| 8 | Idempotency on Cosmos writes | Replay a mission with same idempotency key — second call returns cached | `mcp-calls.json` look for `replayed: true` |
| 9 | Every external call goes through MCP | grep orchestrator code for direct SDK imports — none should exist | source |
| 10 | Cosmos writes partitioned by /tenantId | Inspect any `mcp-calls.json` entry — every record has `tenantId` field | `mcp-calls.json` |
| 11 | Exactly 2 predefined gates with timeout | `audit.json` has exactly 2 `GATE_REQUESTED` and 2 `GATE_APPROVED` | `audit.json` |
| 12 | 6 intervention types | `interventions.json` should have all 6 distinct intent values across the run | `interventions.json` |
| 13 | Predefined gates non-bypassable | Try `interveneRun(intent: OVERRIDE_DECISION, payload: { kind: "skip_gate" })` — refused | response body |
| 14 | All interventions audit-logged | Every entry in `interventions.json` corresponds to a row in `audit.json` | both files |
| 15 | Full trace per run | `trace.json` has ≥ 50 spans for a complete mission | `trace.json` |
| 16 | Decision Pack output, schema-validated | `decision-pack.json` parses against `DecisionPack` Zod schema | `decision-pack.json` |
| 17 | Every line explainable | `docs/MODULE_*_WALKTHROUGH.md` covers every file and key function | `docs/` |

## Scenario tests (run these manually for the demo)

### Scenario 1: Happy path (≈30s with compress=600)

```bash
SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs
cat artifacts/runs/<latest>/decision-pack.json
```

**Expected:**
- `status: "COMPLETED"`
- `leaderboard.length === 3` (or whatever topN ended at after UPDATE_GOAL)
- `evalSummary.every(e => e.passed === true)`
- `interventionCount >= 1`
- `panelSlot.candidateId` set

### Scenario 2: Gate-bypass refusal

In the UI Agent tab (or via curl):

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H "content-type: application/json" \
  -d '{"query":"mutation { interveneRun(runId:\"<id>\", intent: OVERRIDE_DECISION, payload: { kind: \"skip_gate\", target: \"GATE_1\" }, operator: \"test@x.com\") { accepted reason auditId } }"}'
```

**Expected:**
- `accepted: false`
- `reason: "Predefined gates are non-bypassable. Use the Approvals tab to approve normally."`
- `auditId` is a UUID

### Scenario 3: Confirmation flow on goal mutation

First call (no confirm):

```bash
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"mutation { interveneRun(runId:\"<id>\", intent: UPDATE_GOAL, payload: { topN: 5 }, operator: \"test@x.com\") { accepted requiresConfirmation diff reason } }"}'
```

**Expected:**
- `accepted: false`
- `requiresConfirmation: true`
- `diff` shows `{ topN: 5 }`
- `reason: "confirmation required"`

Second call with `confirmed: true`:

```bash
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"mutation { interveneRun(runId:\"<id>\", intent: UPDATE_GOAL, payload: { topN: 5 }, operator: \"test@x.com\", confirmed: true) { accepted diff } }"}'
```

**Expected:**
- `accepted: true`
- `diff` shows version bump to 2

### Scenario 4: Rationale required for OVERRIDE_DECISION

Try without rationale:

```bash
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"mutation { interveneRun(runId:\"<id>\", intent: OVERRIDE_DECISION, payload: { kind: \"reject_candidate\", target: \"c04\" }, operator: \"test@x.com\") { accepted reason } }"}'
```

**Expected:**
- `accepted: false`
- `reason: "rationale required for this intent"`

### Scenario 5: Idempotent MCP replay

Run two missions back to back. Inspect `mcp-calls.json` of the second:

```bash
cat artifacts/runs/<run2>/mcp-calls.json | jq '.[] | select(.tool == "voice-call") | {idempotencyKey, replayed: (.error == null)}'
```

**Expected:** keys reuse hash from same `(runId, candidateId, attempt)` tuple. If you replay the SAME mission's call (e.g., via `REPLAY_ACTION`), the second call should appear in the log but not double the cost (`costUsd: 0` on replay).

### Scenario 6: Compressed mode + drift

```bash
SMAYA_COMPRESS_FACTOR=60 node scripts/e2e.mjs
cat artifacts/runs/<latest>/trace.json | jq '.[] | select(.events[]? .name == "heartbeat.drift_alert")' | head
```

**Expected:** zero or few drift alerts (because compress reduces the cadence proportionally; drift is only flagged when wall-clock exceeds expected by >30s).

### Scenario 7: Budget pause

```bash
SMAYA_BUDGET_USD=0.05 SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs 2>&1 | grep BUDGET
cat artifacts/runs/<latest>/audit.json | jq '.[] | select(.type == "BUDGET_PAUSE")'
```

**Expected:** mission writes a `BUDGET_PAUSE` audit entry once total cost exceeds `0.04` (80% of cap).

### Scenario 8: PII does not leak

Inspect any candidate row:

```bash
cat artifacts/runs/<latest>/run-record.json
# Then probe the in-memory store via the API:
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"{ run(runId: \"<id>\") { runId stage } }"}'
```

**Expected:** the `candidates` Cosmos container has only `[NAME:XXXXXXXX]`, `[EMAIL:XXXXXXXX]`, `[PHONE:XXXXXXXX]` tokens — no raw email, name, or phone strings. The PII golden eval (run before any `candidates` write) prevents this from being possible.

## Unit / integration tests

Each package has its own vitest harness. Run all:

```bash
npm test
```

Per package:

```bash
npm test -w @smaya/shared
npm test -w @smaya/data
npm test -w @smaya/mcp-tools
# ...etc
```

> Test coverage today is sparse — the assessment prioritized end-to-end behavior over unit tests. The behavior evals + scenario tests above are the primary signal. Adding focused unit tests for `gates.ts`, `intent.ts`, and `pii.ts` is the next iteration.

## Inspecting a live run

While `npm run dev` is up, use GraphQL Playground or curl:

```bash
# List runs
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"{ runs { runId stage status costUsd pendingGates { gate expiresAt } } }"}'

# Audit log of one run
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"{ audit(runId: \"<id>\") }"}'

# Decision Pack (after completion)
curl -s -X POST http://localhost:4000/graphql -H "content-type: application/json" \
  -d '{"query":"{ decisionPack(runId: \"<id>\") }"}'
```

## What to expect when something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE: 5101 / 4000 / 3000` | Previous dev stack still bound | Wait ~30s for TIME_WAIT, or kill processes via PowerShell `Get-NetTCPConnection` |
| `pdf-parse: ENOENT 05-versions-space.pdf` | You're using `pdf-parse` instead of `pdfjs-dist` | Already fixed — see `docs/AI_RETRO.md` #6 |
| `LEADERBOARD_BIAS eval failed: ratio=0.5` | N=10 candidates, top-3 lopsided one group | Already mitigated with small-sample fallback |
| `PII assertion failed: raw email present` | Decision pack contains panel emails | Already scoped to `candidates` container only — see `docs/AI_RETRO.md` #5 |
| `Cannot access 'rationale' before initialization` | Variable shadowing | Already fixed in `resolvers.ts` |

All historical issues and their fixes are documented in `docs/AI_RETRO.md`.
