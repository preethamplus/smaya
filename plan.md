# plan.md — Smaya Mission Strategy

## 1. LLM choice

**Selected: deterministic local mock stub** (Option 3 in §2.5).

Why:
- The non-negotiable is **zero requests to Exterview for credentials** + **end-to-end completion in compressed test window**. A deterministic stub is the only path that is both reproducible and offline-runnable on any reviewer's machine.
- The orchestrator is **LLM-agnostic** by design: every prompt-bearing call goes through `packages/shared/src/llm.ts` `LLMClient` interface. The mock is one impl; an Anthropic-backed `AnthropicLLM` and `OllamaLLM` are also wired (via env `LLM_PROVIDER=anthropic|ollama|mock`, default `mock`). Behavior evals therefore work in all three modes — the golden datasets are identical.
- The deterministic stub is keyed by SHA-256 of the prompt+system+temperature tuple → same input ⇒ same output ⇒ score-stability eval is satisfiable without hand-rolled fixtures.

## 2. Sequencing & module boundaries

```
Stage 1: shared (schemas, telemetry, cost) — foundational
Stage 2: data (Cosmos client + in-memory shim + Redis idempotency)
Stage 3: mcp-tools (5 tools, all local stubs)
Stage 4: evals (3 behavior evals + golden sets)
Stage 5: orchestrator (14 stages + heartbeat + intervention layer)
Stage 6: intervention-api (GraphQL)
Stage 7: ui (Next.js, 3 tabs)
```

PR boundaries map 1:1 to the 5 modules in §7 of the spec, plus an initial scaffold PR. Branches:
- `pr/00-scaffold`
- `pr/01-module-c-data`
- `pr/02-module-b-mcp-tools`
- `pr/03-module-a-orchestrator`
- `pr/04-module-e-intervention-api`
- `pr/05-module-d-ui`

## 3. Mission state machine (14 stages)

| # | Stage | Trigger | Side effect | Pre-side-effect eval |
|---|---|---|---|---|
| 1 | INGEST | wake-up | enqueue `parse(c)` × 10 | — |
| 2 | PARSE | per-resume | Cosmos write of `candidates/{id}` | **PII-masking** |
| 3 | SCORE_R1 | after PARSE | scores written | — |
| 4 | GATE_1 | after R1 | wait recruiter approval | — (gate UX) |
| 5 | PHONE_SCREEN | after GATE_1 | `voice-call` MCP per candidate | — |
| 6 | NUDGE | NO_ANSWER | retry × 3 backoff (500ms/2s/8s) | idempotency |
| 7 | SCORE_R2 | after PHONE_SCREEN | scores updated | — |
| 8 | AVATAR | after R2 | `avatar-interview` MCP | — |
| 9 | SCORE_R3 | after AVATAR | composite + leaderboard | **score-stability** |
| 10 | SEND_LEADERBOARD | after R3 | `slack-poster` + `outlook-scheduler` | **leaderboard-bias** |
| 11 | GATE_2 | after SEND | wait panel slot confirmation | — (gate UX) |
| 12 | SCHEDULE_PANEL | after GATE_2 | `outlook-scheduler` calendar event | — |
| 13 | DECISION_PACK | after SCHEDULE | `decisionPacks` write | schema-pin |
| 14 | SELF_PAUSE | terminal | trace flush | — |

## 4. Heartbeat strategy

- **Active cadence** (waiting on MCP completion / phone screen): 60s real → 1s in compressed mode.
- **Passive cadence** (waiting on human gate): 5min real → 5s compressed.
- **Drift target**: < 30s. We measure `actual − expected` per tick and emit `heartbeat.drift_ms` to OTel. Alert at > 30s sustained 3 ticks.
- **Skip detection**: persisted `lastTickAt`; if `now − lastTickAt > cadence × 2.5` we emit `heartbeat.skip` and re-enter recovery.
- Implemented as a stateful Durable-Function-style timer (we use `setTimeout` + Cosmos checkpoint, so resume works even if the orchestrator process dies mid-tick).

## 5. Intervention layer

Chat → **intent extractor** (regex+keyword classifier; LLM-backed when not in mock mode) → **allow-list validator** → **plan diff** → **confirmation** → **audit** → **re-plan**.

The five primitives in §3.2 map to exactly this pipeline. `STOP` and `RESUME` short-circuit the diff/confirm steps but still audit. Predefined gates (`GATE_1`, `GATE_2`) are enumerated in `NON_BYPASSABLE` and `OVERRIDE_DECISION` against them is refused with `reason: "gate is non-bypassable"`.

## 6. Guardrails

| Guardrail | Where |
|---|---|
| Budget cap $5.00 | `shared/src/cost-ledger.ts`; auto-pause on `usage > 0.8 × cap` |
| Schema | Zod on every MCP I/O via `mcp-tools/src/wrap.ts` |
| Recursion ≤ 3 | `orchestrator/src/depth.ts`; circular detection by `parentRunId` chain |
| PII | `mcp-tools/src/resume-parser/mask.ts` + `data/src/assertions.ts` (post-parse) |
| Outbound | Every MCP call requires `gateClearance` flag stamped by orchestrator |
| Idempotency | All Cosmos writes go through `data/src/idempotent.ts` (Redis-backed, 24h TTL) |
| Intervention | `intervention-api/src/allowlist.ts` |

## 7. Compressed test mode

A single env var, `SMAYA_COMPRESS_FACTOR` (default `1.0`, e.g. `60` ⇒ 1 minute simulated = 1 second wall). Heartbeat cadence and gate timeouts both honor this. Drift logic measures **wall-clock** drift, not simulated drift, so cadence correctness is real.

## 8. What's mocked vs real

Real:
- PDF parsing via `pdfjs-dist` (synthetic PDFs are real PDFs).
- Cosmos SDK against the emulator (with in-memory shim fallback).
- Redis idempotency (with in-memory shim fallback).
- OTel tracing → Jaeger (or in-process span buffer in shim mode).
- Zod schemas at every boundary.
- Heartbeat / drift / skip detection.
- GraphQL with allow-list validation.

Mocked (per spec §1):
- Anthropic API (mock LLM is the default; real impl is wired and runs if `ANTHROPIC_API_KEY` is set).
- Slack endpoint (`slack-poster` runs a local HTTP server that records POSTs).
- Microsoft Graph (`outlook-scheduler` writes JSON artifacts).
- VideoSDK / ElevenLabs / Avatar (deterministic transcript / signal stubs).

## 9. Where AI got it wrong (running notes)

- Initial Claude pass over the orchestrator generated a `while(true)` poll loop instead of a stateful timer; this would have tripped non-negotiable #4 (drift+skip monitoring impossible to compute without explicit cadence). Rewrote against an explicit `Heartbeat` class with `nextTickAt` persisted to Cosmos.
- The intent classifier first version used the LLM directly for chat → intent. Per §3.3 ("Treating chat as direct LLM prompt") this is auto-reject. Intent layer is now a deterministic regex-first classifier with LLM only for disambiguation, fully bypassable in mock mode.
- See `docs/AI_RETRO.md` for the full list.
