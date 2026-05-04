# 17 Non-Negotiables → Code Path Map

This file maps every line of §6 of the spec to the file that proves it.

| # | Non-Negotiable | Where it lives |
|---|---|---|
| 1 | One-command boot (`docker compose up && npm run dev`) | `docker-compose.yml`, `scripts/dev.mjs`, root `package.json`. The system also runs without Docker via in-memory shims. |
| 2 | Zero requests to Exterview for credentials | LLM defaults to deterministic mock; mock Slack & Outlook are local HTTP servers; Cosmos & Redis have in-memory shims. See `plan.md` §1. |
| 3 | E2E mission completes in compressed window | `SMAYA_COMPRESS_FACTOR` env var, plumbed through `packages/shared/src/time.ts`, used by `Heartbeat` and gate timeouts. |
| 4 | Heartbeat with drift + skip monitoring | `packages/orchestrator/src/heartbeat.ts` — `Heartbeat.tick` measures `driftMs` and emits `heartbeat.drift_alert`/`heartbeat.skip` to the trace. |
| 5 | At least 3 pre-side-effect behavior evals with golden datasets | `packages/evals/src/{pii-eval,score-stability-eval,bias-eval}.ts` and `fixtures/golden/{pii-golden,bias-golden}.json`. Called *before* their side-effect side in `mission.ts` (PII before parse-write, score-stability before phone-screen, bias before Slack/email). |
| 6 | Per-mission budget cap with auto-pause at 80% | `packages/shared/src/cost-ledger.ts`, called in `Mission.softBudgetPause` from the heartbeat tick. |
| 7 | Zod schema on every MCP input/output | `packages/mcp-tools/src/wrap.ts:defineTool` parses both `inputSchema` and `outputSchema`. Every tool registers via `defineTool`. |
| 8 | Idempotency on all Cosmos writes | `packages/data/src/idempotency.ts` provides `getOrPut`. `wrap.ts` keys every MCP call by `mcp:${tool}:${stableHash(...)}`. The `repos.putScore`/`putRun` writes in `mission.ts` are themselves idempotent by primary key. |
| 9 | Every external call goes through MCP — not direct SDK | The orchestrator never imports `redis`, `@azure/cosmos`, or any tool SDK directly. It imports `voiceCall`, `slackPoster`, etc. from `@smaya/mcp-tools`. |
| 10 | Every Cosmos write partitioned by `/tenantId` | `packages/data/src/store.ts:upsert` throws if `tenantId` is missing. `CosmosStore` passes `partitionKey: tenantId` on every write. `containers.ts` exports `PARTITION_KEY = "/tenantId"`. |
| 11 | Exactly 2 predefined human gates with timeout + escalation | `packages/orchestrator/src/gates.ts` — `GATE_1` and `GATE_2` only. `GATE_TIMEOUT_SIM_MS = 4 * 60 * 60 * 1000`. The orchestrator transitions to `AWAITING_GATE` and `awaitGate` resolves on bus event. |
| 12 | Mid-flight intervention: pause, resume, stop, override, goal mutation, context injection | `Mission.{pause, resume, stop, overrideRejectCandidate, updateGoal, addContext, deviate, replayAction}` in `packages/orchestrator/src/mission.ts`. |
| 13 | Predefined gates non-bypassable via chat | `packages/intervention-api/src/allowlist.ts` — first check refuses `OVERRIDE_DECISION` with `kind: skip_gate` *before* any other validation. |
| 14 | All interventions audit-logged with operator identity + rationale | Every code path in `resolvers.ts:interveneRun` calls `repos.logIntervention(...)` with `operator` + `rationale`. `OVERRIDE_DECISION` and `DEVIATE` require rationale (allow-list returns `ok: false` without one). |
| 15 | Full trace per run | `packages/shared/src/telemetry.ts:tracer` buffers spans for every run. Each MCP call wraps in a `mcp.${name}` span. `tracer.snapshot()` is dumped to `artifacts/runs/<runId>/trace.json` by the E2E harness. |
| 16 | Decision Pack output, schema-validated | `packages/shared/src/schemas.ts:DecisionPack` + `repos.putDecisionPack` calls `.parse(...)` before write. Mission writes one in `stageDECISION_PACK`. |
| 17 | Every line of code explainable by candidate | `docs/MODULE_*_WALKTHROUGH.md`. Code prefers explicitness over cleverness. Most files carry one short comment block at the top explaining *why*. |
