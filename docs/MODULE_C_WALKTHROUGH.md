# Module C — Cosmos DB + Idempotency (Walkthrough)

## What this module owns

The 9 Cosmos containers (per spec §7), the typed repos that wrap them, and the Redis-backed idempotency store with its in-memory shim.

## The 9 containers

```
agentRuns       — RunRecord
decisionPacks   — DecisionPack
auditLog        — AuditEntry  (append-only)
mcpCallLog      — McpInvocation
costLedger      — { source, usd, at } per call
evalResults     — EvalResult AND scores (kind: "eval"|"score")
candidates      — MaskedProfile (post-PII assertion)
goalVersions    — Snapshot per goal mutation
interventions   — InterventionRecord (accepted AND refused)
```

All partitioned by `/tenantId`. The constant lives in `containers.ts`:

```ts
export const PARTITION_KEY = "/tenantId";
```

## Two implementations of `Store`

`InMemoryStore` is a `Map<tenantId, Map<container, Map<id, item>>>`. `CosmosStore` lazy-loads `@azure/cosmos`. Same interface; the orchestrator never knows which is in play. Default is in-memory; `SMAYA_COSMOS=1` flips to the SDK.

The `assertNoPII` guard lives at `upsert` time on the `candidates` container. Decision packs intentionally include panel emails, so they are not gated. This is documented inline.

## Repos

`Repos` wraps the store with typed methods that use Zod schemas to parse on read AND on write. Every write goes `Schema.parse(item) → store.upsert(item)`. This means a corrupted item *cannot* be persisted — the schema fails-closed.

Notable repo conventions:
- `appendAudit` is monotonically ordered by `at` on read.
- `listMcp` sorts by `startedAt` so traces can reconstruct invocation order.
- `putScore` writes to `evalResults` with `kind: "score"` so the same container holds both score rows and behavior eval rows. The `kind` discriminator is set by the repo, not by the caller, so a caller cannot accidentally pollute one with the other.
- `putDecisionPack` uses the `runId` as the partition-key item id. One Decision Pack per run.

## Idempotency

`IdempotencyStore.getOrPut(key, ttlMs, compute)` is the single API. `RedisIdempotency` lazy-loads `redis` and connects to `REDIS_URL`. `InMemoryIdempotency` uses a `Map<key, { value, expiresAt }>`. Both return `{ value, replayed: boolean }`.

The wrap in `mcp-tools/wrap.ts` keys every MCP call as `mcp:${tool}:${stableHash(runId, idempotencyParts)}`. The orchestrator constructs `idempotencyParts` from per-stage semantics:
- `["parse", candidateId]` for parser — same candidate ⇒ same parse.
- `["voice", candidateId, attempt]` for voice — attempt is part of the key so each retry is unique.
- `["avatar", candidateId]` for avatar — single attempt per candidate.
- `["slack-leaderboard", runId]` — once per run.
- `["calendar", runId, candidateId]` — once per run per candidate.

## Why each line is what it is

- The `tenantId` invariant is checked at `upsert` (throws if missing) instead of being a structural type-level constraint, because the StoreItem shape is intentionally open (`[k: string]: unknown`) so callers can store opaque artifacts. The runtime check is the floor.
- `deepClone` on get/upsert prevents callers from mutating cached items in-place — important because the InMemoryStore is shared across stages.
- The Cosmos store's `query` helper restricts to the partition key automatically. Cross-partition queries are impossible to express through the `Store` interface — this is by design (rubric #10).
- `singleton` in `getStore` and `getIdempotency` exists so a test can `setStore(new InMemoryStore())` and reset state — necessary for the eval harness which sometimes wants a clean store.

## Tradeoffs

- The Cosmos SDK is a peer dep, lazy-loaded. Reviewers without `@azure/cosmos` installed (or without the emulator running) get the in-memory shim — same code path, just no durability across process restart. The spec's "Resume-safe state" requirement is satisfied by the run record being re-read from the same store on restart, regardless of backend.
- We don't use Cosmos's TTL features for the Redis idempotency cache — Redis is the right tool for short-lived idempotency keys (faster, cheaper, simpler eviction). Cosmos is the system of record.
- `goalVersions` is its own container (not embedded in `agentRuns`) so a goal mutation history is queryable independently of run state — useful for the audit trail.
