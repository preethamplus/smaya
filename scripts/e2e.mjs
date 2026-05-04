// End-to-end harness: starts mock servers, runs the mission, exercises 6 chat
// interventions through the in-process API, and writes:
//   artifacts/runs/<runId>/decision-pack.json
//   artifacts/runs/<runId>/audit.json
//   artifacts/runs/<runId>/trace.json
//   artifacts/runs/<runId>/interventions.json
//
// All runs use the in-memory store + idempotency by default (no Docker required).
// Set SMAYA_COSMOS=1 / SMAYA_REDIS=1 to run against the emulator.

import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// We boot the orchestrator and intervention API in-process via tsx.
const tsx = await import("tsx/esm/api");
await tsx.register();

const imp = (rel) => import(pathToFileURL(resolve(rel)).href);

const { setCompressFactor, tracer } = await imp("packages/shared/src/index.ts");
const { startMockSlack, startMockOutlook, resetMocks } = await imp("packages/mcp-tools/src/mock-servers.ts");
const { Mission, registerLiveMission, approveGate } = await imp("packages/orchestrator/src/index.ts");
const { repos } = await imp("packages/data/src/index.ts");
const { resolvers } = await imp("packages/intervention-api/src/index.ts");

const COMPRESS = Number(process.env.SMAYA_COMPRESS_FACTOR ?? 60);
setCompressFactor(COMPRESS);

const slackServer = startMockSlack(5101);
const outlookServer = startMockOutlook(5102);
resetMocks();

const goal = { topN: 3, jdId: "smaya-senior-backend-2026", excludedCandidates: [], skipStages: [] };
const mission = new Mission({
  tenantId: "default",
  goal,
  resumesDir: resolve("fixtures/resumes/pdf"),
  budgetUsd: 5.0,
});
registerLiveMission(mission);

console.log(`[e2e] mission ${mission.run.id} starting (compress=${COMPRESS})`);

// Run mission and interventions concurrently. We schedule chat-driven intent
// firings on a short timer so they land while the mission is mid-flight.
const interventionsPlan = [
  { atMs: 800,  intent: "STATUS_QUERY",       payload: { raw: "where are you on candidate 4?" } },
  { atMs: 1500, intent: "ADD_CONTEXT",        payload: { context: "Also consider GitHub activity." } },
  { atMs: 2200, intent: "UPDATE_GOAL",        payload: { topN: 5 }, confirm: true },
  { atMs: 2800, intent: "OVERRIDE_DECISION",  payload: { kind: "skip_gate", target: "GATE_1" } }, // refused
  { atMs: 3400, intent: "REPLAY_ACTION",      payload: { kind: "score", candidateId: "c07" } },
  { atMs: 4500, intent: "OVERRIDE_DECISION",  payload: { kind: "reject_candidate", target: "Krithika Rao" }, rationale: "Not a fit for this round.", confirm: true },
];

const operator = "ops@smaya.example.com";

const interventionTask = (async () => {
  // Fire interventions while mission runs.
  for (const step of interventionsPlan) {
    await delay(step.atMs);
    try {
      const res = await resolvers.Mutation.interveneRun(null, {
        runId: mission.run.id, intent: step.intent, payload: step.payload,
        rationale: step.rationale ?? null, operator, confirmed: false,
      });
      console.log(`[e2e] intent=${step.intent} accepted=${res.accepted} requiresConfirm=${res.requiresConfirmation} reason=${res.reason ?? ""}`);
      if (res.requiresConfirmation && step.confirm) {
        const c = await resolvers.Mutation.interveneRun(null, {
          runId: mission.run.id, intent: step.intent, payload: step.payload,
          rationale: step.rationale ?? null, operator, confirmed: true,
        });
        console.log(`[e2e] intent=${step.intent} confirm=${c.accepted}`);
      }
    } catch (err) {
      console.log(`[e2e] intent=${step.intent} error=${err.message}`);
    }
  }
})();

// Auto-approve gates so the mission completes.
const gateApprover = (async () => {
  let g1 = false, g2 = false;
  while (!(g1 && g2)) {
    await delay(200);
    const status = mission.status();
    if (status.stage === "GATE_1" && !g1) {
      try { await approveGate(mission.run.id, mission.run.tenantId, "GATE_1", "recruiter@smaya.example.com"); g1 = true; }
      catch { /* not requested yet */ }
    }
    if (status.stage === "GATE_2" && !g2) {
      try { await approveGate(mission.run.id, mission.run.tenantId, "GATE_2", "panel@smaya.example.com"); g2 = true; }
      catch { /* not requested yet */ }
    }
    if (status.status === "COMPLETED" || status.status === "STOPPED" || status.status === "FAILED") break;
  }
})();

await mission.run_();
await Promise.all([interventionTask, gateApprover]);

// Persist artifacts.
const outDir = resolve("artifacts/runs", mission.run.id);
mkdirSync(outDir, { recursive: true });

const dump = async (name, data) => {
  const p = resolve(outDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`[e2e] wrote ${p}`);
};

await dump("run-record.json", await repos.getRun(mission.run.tenantId, mission.run.id));
await dump("decision-pack.json", await repos.getDecisionPack(mission.run.tenantId, mission.run.id));
await dump("audit.json", await repos.listAudit(mission.run.tenantId, mission.run.id));
await dump("interventions.json", await repos.listInterventions(mission.run.tenantId, mission.run.id));
await dump("mcp-calls.json", await repos.listMcp(mission.run.tenantId, mission.run.id));
await dump("evals.json", await repos.listEvals(mission.run.tenantId, mission.run.id));
await dump("trace.json", tracer.snapshot());

slackServer.close();
outlookServer.close();
process.exit(0);
