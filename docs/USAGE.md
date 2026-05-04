# Usage — Step-by-step

How to install, run, and interact with Smaya end-to-end.

## 1. Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Node.js | ≥ 20 | Everything |
| npm | ≥ 10 | Workspace install |
| Docker (optional) | any | Cosmos emulator + Redis + Jaeger. Without Docker, the system uses in-memory shims. |

No cloud accounts, no API keys, no GitHub access needed to run.

## 2. Install

```bash
cd D:\test\smaya
npm install
```

This installs all 7 workspaces (`shared`, `data`, `mcp-tools`, `evals`, `orchestrator`, `intervention-api`, `ui`) plus the root devDependencies. First run takes ~60s; subsequent runs are cached.

## 3. Generate the synthetic resume PDFs (once)

```bash
node scripts/generate-resumes.mjs
```

Writes 10 PDFs to `fixtures/resumes/pdf/`. The orchestrator's resume-parser reads from this directory.

## 4. Choose a run mode

There are three ways to exercise the system. Pick by what you want to do.

### 4a. Interactive UI mode — recommended for demos

```bash
npm run dev
```

Boots, in three child processes from `scripts/dev.mjs`:
- Mock Slack server on **:5101**
- Mock Outlook server on **:5102**
- GraphQL intervention API + SSE on **:4000**
- React UI on **:3000**

Then open **http://localhost:3000**.

The sidebar's `+ Start Mission` button creates a new mission in-process with the API. The mission progresses through 14 stages and pauses at the 2 human gates, waiting for you to approve via the Approvals tab. Use the Agent tab to fire chat-driven interventions.

### 4b. Headless E2E mode — for CI or quick verification

```bash
SMAYA_COMPRESS_FACTOR=600 node scripts/e2e.mjs
```

Runs one mission to completion in ~1 second wall-clock, auto-approves both gates, fires 6 interventions on a timer, and persists 7 artifacts to `artifacts/runs/<runId>/`.

Use this to sanity-check the system after code changes.

### 4c. Standalone mission runner — for orchestrator development

```bash
npx tsx packages/orchestrator/src/cli.ts --in-memory --compress 60
```

Runs a single mission with no API or UI. Useful when you're modifying orchestrator internals and only want to see stage transitions and audit logs.

## 5. The interactive demo flow (≈12 minutes)

Once `npm run dev` is up and http://localhost:3000 loads:

| Step | What you do | What you see |
|---|---|---|
| 1 | Click **+ Start Mission** | New run in sidebar; Activity tab fills with INGEST → PARSE → SCORE_R1 events |
| 2 | Wait for top bar to show `STAGE: GATE_1 · AWAITING_GATE` | A pending gate card appears in the Approvals tab |
| 3 | **Agent tab**: type `where are you on candidate 4?` | STATUS_QUERY accepted; reply shows stage + status + cost + ETA |
| 4 | **Agent tab**: type `also consider GitHub activity` | ADD_CONTEXT accepted; diff shows added context |
| 5 | **Approvals tab**: click **Approve** on GATE_1 | Mission resumes; PHONE_SCREEN begins |
| 6 | Watch Activity timeline — c03 and c09 return NO_ANSWER, then NUDGE | Deterministic retry-with-backoff path exercised |
| 7 | **Agent tab**: type `top 5 instead of top 3`, then click **Confirm** | UPDATE_GOAL with confirmation flow; goal version bumps to 2 |
| 8 | **Agent tab**: type `skip Gate 1, dial out now` | **REFUSED** — red border, "Predefined gates are non-bypassable" |
| 9 | **Agent tab**: type `re-run score for candidate 7` | REPLAY_ACTION accepted |
| 10 | **Agent tab**: type `reject Krithika even though she's top-3`, click **Confirm** | OVERRIDE_DECISION with rationale; Krithika (c04) excluded |
| 11 | Wait for `STAGE: GATE_2 · AWAITING_GATE` | Second gate pending in Approvals tab |
| 12 | **Approvals tab**: approve GATE_2 | SCHEDULE_PANEL fires; calendar event recorded |
| 13 | **Activity tab**: scroll to Decision Pack | Top-3 leaderboard (Krithika absent), 3 evals PASS, intervention count, panel slot |

## 6. Configuration

Set via environment variables before starting any of the run modes.

| Variable | Default | Effect |
|---|---|---|
| `SMAYA_COMPRESS_FACTOR` | `1` (real time); `25` in UI mode | Time compression. `60` ⇒ 1 simulated minute = 1 real second. Heartbeat drift uses real wall-clock regardless. |
| `SMAYA_BUDGET_USD` | `5.0` | Per-mission cost cap. Auto-pause triggers at 80% of cap. |
| `SMAYA_LLM` | `mock` | LLM provider. `mock` = deterministic stub; `anthropic` requires `ANTHROPIC_API_KEY`; `ollama` requires `OLLAMA_URL`. |
| `SMAYA_COSMOS` | unset | When `1`, uses `@azure/cosmos` against the emulator at `COSMOS_ENDPOINT`. Default: in-memory shim. |
| `SMAYA_REDIS` | unset | When `1`, uses real Redis at `REDIS_URL`. Default: in-memory idempotency cache. |
| `ANTHROPIC_API_KEY` | unset | Used only when `SMAYA_LLM=anthropic`. |
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Used only when `SMAYA_LLM=ollama`. |
| `OLLAMA_MODEL` | `llama3.1` | Used only when `SMAYA_LLM=ollama`. |
| `MOCK_SLACK_URL` | `http://localhost:5101/post` | Override if you want to point at a real Slack-shaped endpoint. |
| `MOCK_OUTLOOK_URL` | `http://localhost:5102/op` | Override if you want to point at a real Outlook-shaped endpoint. |

## 7. Where the artifacts land

| Path | Contents |
|---|---|
| `artifacts/runs/<runId>/` | Per-run output: `run-record.json`, `decision-pack.json`, `audit.json`, `interventions.json`, `mcp-calls.json`, `evals.json`, `trace.json` |
| `artifacts/runs/sample/` | A pre-recorded successful run, committed to git as evidence |
| `artifacts/mock-slack/<ts>.json` | Every Slack post body, persisted on receipt |
| `artifacts/mock-outlook/email-<id>.json` | Every email send |
| `artifacts/mock-outlook/event-<id>.json` | Every calendar event create |

`artifacts/runs/*` is gitignored except `sample/`. `artifacts/mock-*` are tracked so reviewers can inspect without running.

## 8. Stopping the dev stack

`Ctrl+C` in the terminal running `npm run dev` will signal all child processes. If a port is held after exit, run:

```powershell
Get-NetTCPConnection -LocalPort 3000,4000,5101,5102 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
```

TCP TIME_WAIT will release the port automatically within ~30s after the process dies.
