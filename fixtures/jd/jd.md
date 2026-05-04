# Senior Backend Engineer (Agentic Systems) — Smaya

**Location:** Remote (IST timezone preferred) · **Type:** Full-time

## About the role

We are hiring a senior backend engineer to own the core orchestration layer of Smaya, our autonomous agent platform. You will design and ship long-running, goal-driven systems that combine LLM tool-use with deterministic guardrails, behavior evals, and human-in-the-loop controls.

## You will

- Own a 14-stage Durable Functions orchestration that runs autonomously over a 24-hour window with mid-flight intervention.
- Design MCP tool boundaries with Zod-validated I/O, OAuth 2.1 flows, and idempotency keys.
- Build behavior eval harnesses with golden datasets, drift detection, and pre-side-effect gating.
- Ship guardrails — budget caps, schema validation, recursion bounds, PII masking — that hold under partial failure.
- Pair with our applied AI team on prompt strategy, but the orchestrator must be **LLM-agnostic**.

## Required

- 5+ years backend engineering, **TypeScript** and **Python** both.
- Deep experience with at least one of: Azure Durable Functions, AWS Step Functions, Temporal, Cadence.
- Production experience with at least one document database (Cosmos, Mongo, Dynamo, Firestore).
- Hands-on with OpenTelemetry, distributed tracing, and structured logging.
- Comfortable with Docker and local-first development.

## Strongly preferred

- Worked on agentic systems in production (not just demos).
- Built a behavior eval pipeline (golden sets, threshold-based, drift-monitored).
- Experience with MCP, function-calling, or schema-pinned tool use.
- Understanding of human-in-the-loop primitives (gates, approvals, mid-flight intervention).

## Nice to have

- Prior recruiting / HR-tech domain experience.
- Open-source contributions to durable execution, orchestrator, or eval-harness projects.
- GraphQL surface design experience.

## What success looks like at 90 days

- One mission of the recruiting agent runs end-to-end, autonomously, with at least 6 different intervention types exercised, on a reviewer's laptop in under an hour.
- A clean MCP boundary that any of our 5 stub tools (`resume-parser`, `voice-call`, `avatar-interview`, `slack-poster`, `outlook-scheduler`) can be swapped for a real implementation without orchestrator changes.

## Compensation

Competitive, equity-bearing. We hire for judgment.
