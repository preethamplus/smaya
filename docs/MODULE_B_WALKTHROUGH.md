# Module B — MCP Tools (Walkthrough)

## What this module owns

Five MCP tools that abstract every external call the orchestrator makes:

| Tool | Real or stub | What it returns |
|---|---|---|
| `resume-parser` | Real (pdfjs-dist + custom mask) | `{ masked: MaskedProfile, raw: ParsedResumeRaw }` |
| `voice-call` | Stub (deterministic) | NO_ANSWER (c03/c09 first attempt) or COMPLETED with transcript + screen score |
| `avatar-interview` | Stub (deterministic) | 4-dimension signal + red/green flags |
| `slack-poster` | HTTP client → local mock server | Slack message ts + permalink |
| `outlook-scheduler` | HTTP client → local mock server | Email or Event id + webLink |

Plus `mock-servers.ts` — local HTTP servers on ports 5101 (Slack) and 5102 (Outlook) that record every payload to in-memory arrays exposed via GET, and persist JSON artifacts to `artifacts/mock-slack/` and `artifacts/mock-outlook/`.

## The wrap (`wrap.ts`)

This is the heart of the module. **Every** tool is created via `defineTool({...})` which returns a function `(ctx, input) => output`. The wrap enforces, in this order:

1. **Gate clearance check** — `if (!ctx.gateClearance) throw`. This is the answer to spec §5.3 "No external call without prior gate clearance."
2. **OAuth 2.1 stub** — `validateToken` checks the bearer token against (tool, scope, tenant). Tokens issued by `issueToken` and TTL'd at 5 min.
3. **Zod input validation** — `inputSchema.parse(input)`. Throws on shape mismatch, fails closed.
4. **Idempotency lookup** — `getIdempotency().getOrPut(key, ttl, () => handler(input))`. Same input ⇒ same output, replayed flag set on cache hit.
5. **Output validation** — `outputSchema.parse(out)` inside the cached compute, so cached values are also validated when first written.
6. **Cost ledger** — costs added only on first execution, never on replay.
7. **mcpCallLog write** — every invocation (success and error) writes to Cosmos.
8. **Telemetry span** — `tracer.startSpan("mcp.${name}", attrs)` opens, closes on completion with `mcp.replayed` attribute.

The wrap is the single chokepoint that satisfies rubric #7 (Zod schema on every MCP I/O) and #8 (idempotency on every Cosmos write of MCP results).

## Resume parser

Real PDF text extraction via `pdfjs-dist`'s legacy build (the modern build assumes a browser). Reconstruction:

1. For each page, `getTextContent()` returns items with `transform` (a 6-element matrix; `transform[5]` is Y).
2. Group items by Y, sort Y descending, join into lines.
3. Apply regex extraction: name (first line), email, phone, LinkedIn URL, GitHub URL.
4. Find the location in line 2 by splitting on `·` and filtering out the email/phone parts.
5. `parseExperience` walks lines after "Experience" header, matching `Role — Company` titles, accumulating bullets.
6. `parseEducation` parses lines like `B.Tech CSE, IIT Madras (2017)`.

Then `maskProfile`:

- `tokenize("NAME", value)` returns `[NAME:XXXXXXXX]` where the hex is SHA-256("NAME:value-lowercased").slice(0,8).toUpperCase(). Same for EMAIL and PHONE.
- `generalizeLocation` drops city granularity, keeping only the country. "Bengaluru, India" → "India".
- `yearsTotal` is a sum across `experience` of `(end - start)` parsed from `years` strings like "2022–present".
- `assertNoPII(masked)` runs as a defense-in-depth check before returning.

The output is `{ masked, raw }`. The orchestrator persists only `masked`. The `raw` is passed back to the eval harness and never reaches Cosmos.

## Voice-call stub

Deterministic by design. The `NO_ANSWER` set is fixed (`c03`, `c09` on attempt 1) so the nudge-and-retry path is exercised on every run. The transcript is templated with a per-candidate narrative, sentiment is hash-derived in [-1, 1], duration is hash-derived in [180s, 420s].

Why deterministic: the score-stability eval re-runs scoring against the phone screen output. If the phone screen drifted between runs, score-stability would alert; that defeats its purpose as a model-drift detector. Determinism here is what lets the eval be tight.

## Avatar-interview stub

Same shape as voice-call but returns a 4-dimensional signal. Red flags fire when a dimension < 55, green flags when > 80. Hash-seeded so a candidate gets the same signal across replays — matches the idempotency contract.

## Slack-poster + outlook-scheduler

Both POST to local HTTP servers on 5101/5102. The mock servers record to in-memory arrays AND write JSON artifacts to `artifacts/mock-slack/` / `artifacts/mock-outlook/` for offline review. The UI fetches them via `Query.slackMessages` / `outlookEmails` / `outlookEvents`.

## Why each line is what it is

- `defineTool` returns the wrapped function rather than registering on a singleton registry — this lets the TS types of input/output flow to the orchestrator call site, which is far more readable than a generic `invoke("voice-call", {...})`.
- The `mcpCallLog` write happens BOTH on success (with output) and failure (with error). Without the failure write, drift detection on the eval side has no signal that a tool blew up.
- Mock servers persist artifacts before responding so the artifact is on disk by the time the orchestrator's `outlookScheduler` resolves.
- `pdfjs-dist/legacy/build/pdf.mjs` is used because the non-legacy entry assumes browser globals (window, document) that aren't present in Node.

## Tradeoffs

- pdfjs prints standard-font warnings because we don't pass `standardFontDataUrl`. The text extraction still works because our PDFs use Helvetica (which pdfjs has built-in handling for). We swallow these to noise, not block — the alternative is bundling the standard fonts (~1.5MB) which adds nothing for this assessment.
- The OAuth stub uses an in-memory token map because token persistence isn't a guardrail the spec asks for; the discipline is the validation flow, not durability.
- Idempotency cache TTL is 24h, matching the simulated mission window. Real prod would use shorter TTLs scoped to the tool semantics (e.g. seconds for `resume-parser`, minutes for `voice-call`).
