# Module E — Intervention API (Walkthrough)

## What this module owns

GraphQL surface at `/graphql`, SSE bridge at `/events`, and the allow-list discipline that prevents predefined-gate bypass.

## Schema (`schema.ts`)

Matches §7 spec exactly:

```graphql
mutation interveneRun(
  runId: ID!,
  intent: InterventionIntent!,
  payload: JSON!,
  rationale: String,
  operator: String!,
  confirmed: Boolean
): InterventionResult!
```

Plus query helpers (`runs`, `run`, `audit`, `interventions`, `decisionPack`, `slackMessages`, `outlookEmails`, `outlookEvents`) and a `runEvents` subscription that wraps the in-process bus.

The `JSON` scalar is graphql-yoga's built-in. Payloads are validated by Zod inside the resolver (allow-list).

## Allow-list (`allowlist.ts`)

The single source of truth for what an operator may do. Per intent:

| Intent | Payload schema | Confirm? | Rationale? | Special |
|---|---|---|---|---|
| STATUS_QUERY | optional empty | no | no | — |
| ADD_CONTEXT | `{ context: string }` | no | no | — |
| UPDATE_GOAL | `{ topN?, excludedCandidates?, skipStages? }` | yes | no | — |
| PAUSE | `{ scope? }` optional | no | no | — |
| RESUME | optional empty | no | no | — |
| STOP | `{ reason? }` optional | yes | no | — |
| OVERRIDE_DECISION | `{ kind, target }` | yes | yes | refuses `kind: skip_gate` outright |
| REPLAY_ACTION | `{ kind, candidateId }` | no | no | — |
| DEVIATE | `{ skipStage }` | yes | yes | — |

The function returns `{ ok, requireConfirmation, payload, reason }`. The resolver branches:
- `!ok` → log refusal, return refusal envelope.
- `requireConfirmation && !args.confirmed` → return preview with diff, no mutation.
- `ok && (no confirm needed || confirmed)` → execute the appropriate `Mission` method, log accepted intervention + audit row, return diff envelope.

## Why allow-list-first

§3.3 calls out three auto-rejects:
- "Treating chat as direct LLM prompt" — addressed by routing chat through the intent layer (`orchestrator/src/intent.ts`) before this resolver, AND by validating the structured payload here.
- "Allowing chat to bypass predefined gates" — explicit refusal at the top of `validateIntervention` for `kind: skip_gate`.
- "Mutating goal without confirmation" — `REQUIRES_CONFIRM` set covers UPDATE_GOAL, OVERRIDE_DECISION, DEVIATE, STOP.

Plus:
- "Override without rationale capture" — `REQUIRES_RATIONALE` set covers OVERRIDE_DECISION + DEVIATE; a missing or empty rationale returns `ok: false`.
- "No audit log entry for any intervention" — both refused AND accepted interventions write to `interventions` AND `auditLog`. The audit log entry includes the operator and the diff.

## Resolver dispatch

`Mutation.interveneRun` reaches into `getLiveMission(runId)` to find the in-process `Mission` instance. The `runs` registry is in `orchestrator/src/mission.ts:registerLiveMission`.

Each accepted intent calls a corresponding `Mission` method. The dispatch is a `switch` over `args.intent` rather than a method lookup table because:
1. The TS types for `payload` differ per intent (the allow-list schemas are per-intent).
2. A switch lets the compiler exhaustive-check the `InterventionIntent` enum.
3. Calling site is one place to read for "what do interventions actually do?"

## Name-to-id resolution

§3.1 includes "Reject Krithika even though she's top-3" — the operator types a name, the orchestrator only stores masked profiles. The resolver bridges this by reading `fixtures/resumes/resumes.json` (the source of truth at run-launch) and matching by case-insensitive substring. If the match fails, the resolver throws so the operator gets a clear error rather than a silently-no-op intervention.

## SSE bridge (`server.ts`)

The HTTP server checks for `/events` first. On match, opens a Server-Sent Events stream and subscribes to `bus.onRun(...)`. Every event is `data: <json>\n\n`. The connection is closed when the client disconnects.

This avoids a hard dependency on WS subscriptions (which graphql-yoga supports but requires more client-side wiring). The UI uses the SSE stream by default; the WS subscription endpoint is still wired and can be used by other clients.

## Why each line is what it is

- The allow-list is its own file (not embedded in resolvers) because it's the single point that decides what a chat user is allowed to do. Any tweak — adding a new intent, tightening a confirmation requirement — touches one file.
- The `args.rationale ?? undefined` normalization is there because GraphQL nullable strings come through as `null`, but the allow-list checks `rationale?.trim()` which would treat `null` as truthy.
- The `idFromName` lookup deliberately reads the JSON file every time (no cache) because the source of truth could change between runs and we want intervention semantics to reflect the current launch.
- The SSE handler attaches the listener BEFORE writing any data so we don't miss events that fire between the request landing and the listener being installed.

## Tradeoffs

- Reading `resumes.json` for name resolution makes the resolver coupled to the fixtures directory. In production, we'd resolve through a separate identity service. Documented as a known boundary.
- The bus is in-process. A multi-process deployment would need to swap the bus for Redis pub/sub (or similar). The interface is small — `emitRun`, `onRun` — so the swap is contained.
- The GraphQL `JSON` scalar is permissive. Stricter typing per-intent is possible (with discriminated unions over a `Payload` interface union) but adds API surface for limited gain. Zod handles the strictness at the boundary.
