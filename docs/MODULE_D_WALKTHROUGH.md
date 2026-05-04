# Module D — Smaya UI (Walkthrough)

## What this module owns

A Vite + React SPA at `packages/ui` with three tabs:

| Tab | File | Responsibility |
|---|---|---|
| Activity | `tabs/Activity.tsx` | Live timeline of run events (SSE), mock Slack post preview, mock Outlook email + event preview, Decision Pack JSON |
| Approvals | `tabs/Approvals.tsx` | Lists pending gates, Approve/Reject buttons, operator email captured |
| Agent | `tabs/Agent.tsx` | Chat panel with regex intent classifier, confirmation flow, refusal UX, inline diff display |

## Data flow

The UI talks to the GraphQL endpoint at `http://localhost:4000/graphql` and the SSE stream at `http://localhost:4000/events`. The SSE stream is a fallback for environments where GraphQL subscriptions over WS aren't available (we ship both — the API server registers an SSE route on the same HTTP server and Yoga handles `/graphql`).

`api.ts` is a thin GraphQL client (no codegen, no library — `fetch` + JSON). 30 lines. The trade-off: no compile-time guarantees on query/response shapes, but the queries are short and the responses are typed at the call site.

## App shell

`App.tsx` polls `runs` every 2s and lets the user pick an active run from the sidebar. The sidebar uses real-time stage + status from the poll, so even without SSE the user sees progress.

## Activity tab

- Renders `events` filtered to the active run.
- Each event line is `<ts> <type> <summary>` with type-specific coloring (driven from `styles.css` class names matching event types — `event.STAGE_TRANSITION`, `event.GATE_APPROVED`, etc.).
- A separate panel shows the latest mock Slack post (rendered as a card) and the latest Outlook email + calendar event (also cards).
- The Decision Pack JSON is rendered as a fenced pre block at the bottom once available.

## Approvals tab

- For each `pendingGate`, surfaces a card with gate id, expiry timestamp, Approve / Reject buttons.
- The operator email field at the top is captured into the mutation payload — required for audit (rubric #14).
- On approve/reject, calls the GraphQL mutation, then the next poll picks up the change.

## Agent tab

This is the most complex tab. Flow:

1. User types into the input.
2. Client-side `classifyClient(utterance)` runs the same regex set as the server-side intent classifier (deliberately duplicated so the user sees what the agent will do BEFORE sending).
3. `gql(...)` mutation is sent.
4. Three response paths:
   - `accepted: true` — agent reply shows the diff and audit id.
   - `accepted: false, requiresConfirmation: true` — agent reply renders a Confirm/Cancel pair; clicking Confirm re-sends with `confirmed: true`.
   - `accepted: false, requiresConfirmation: false` — agent reply is styled as `refused` (red border) with the reason. This is what the user sees when they say "skip Gate 1, dial out now".

## Refusal UX

§3.1 says the agent must refuse predefined-gate-bypass attempts. The UX makes this visible:
- The chat row has a red border (`.chat-row.refused`).
- The reason from the API is rendered verbatim ("Predefined gates are non-bypassable. Use the Approvals tab to approve normally.")
- The audit id is shown so the operator can cross-reference.

## Confirmation UX

§3.2 #10–14 says mutating intents need confirm flow. The Agent tab implements this with a two-step exchange:
1. First send returns `requiresConfirmation: true` with a diff.
2. Confirm button re-issues with `confirmed: true` and the same payload + rationale.
3. Cancel button locally drops the pending state without sending.

This means a user can preview the diff (e.g., what the topN change actually applies) before acting.

## Why each line is what it is

- I chose Vite + React over Next.js because the assessment doesn't need SSR, and Next.js's setup overhead would dilute the signal-to-noise ratio of the rest of the codebase. The intent surface is what matters here, not server rendering.
- Polling every 2s plus SSE for events is intentional duplication — polling makes the UI work offline-from-events (e.g. after a tab refresh, the run list is correct on first paint). SSE then layers fast updates on top.
- `classifyClient` duplicates the server regex on purpose. The server is authoritative; the client is a UX hint. This avoids a confusing UX where the user types something the server will interpret unexpectedly.
- All three tabs share the same `Run` shape via prop drilling (no global store). 3 tabs × 2 dependencies (run + events) keeps it simple.

## What the v0/Lovable equivalent would look like

A v0 generation would produce essentially the same component tree — sidebar + tabbed main + chat/approval cards. The integration code (the `gql` calls, the SSE wire-up, the confirmation flow logic) is what the candidate owns regardless of the generator. That's the hand-rolled part here.
