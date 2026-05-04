// Azure Functions Durable-Tasks adapter.
// Each export is referenced by a function.json entryPoint so that
// `func start` discovers and wires the orchestrator + activities automatically.
//
// The Mission class remains the single source of truth for stage logic.
// Activities are thin delegates — they look up the process-local Mission
// instance and call mission.runStage(stage).

import df from "durable-functions";
import type { Context, HttpRequest } from "@azure/functions";
import type { MissionStage } from "@smaya/shared/schemas";
import { resolve } from "node:path";
import { Mission, registerLiveMission, getLiveMission, type MissionInput } from "./mission.js";
import { startMockSlack, startMockOutlook } from "@smaya/mcp-tools/mock-servers";
import type { Heartbeat } from "./heartbeat.js";

// ---- Process-level boot (mock MCP servers, same as cli.ts) ----------------

let booted = false;
function ensureBoot(): void {
  if (booted) return;
  booted = true;
  startMockSlack();
  startMockOutlook();
}

// Heartbeat handles keyed by runId so we can stop them on completion.
const heartbeats = new Map<string, Heartbeat>();

// ---- Init activity --------------------------------------------------------

export async function activityInit(context: Context): Promise<string> {
  ensureBoot();
  const raw = context.bindings.input as MissionInput;
  const input: MissionInput = {
    ...raw,
    resumesDir: resolve(process.cwd(), raw.resumesDir),
  };
  const mission = new Mission(input);
  registerLiveMission(mission);

  const hb = mission.startHeartbeat();
  heartbeats.set(mission.run.id, hb);

  context.log(`[df] mission ${mission.run.id} initialised (stage=${mission.run.stage})`);
  return mission.run.id;
}

// ---- Generic stage-activity factory ---------------------------------------

function stageActivity(stage: MissionStage) {
  return async function (context: Context): Promise<void> {
    const runId = context.bindings.input as string;
    const mission = getLiveMission(runId);
    if (!mission) throw new Error(`[df] no live mission for runId=${runId}`);
    context.log(`[df] ${runId} → ${stage}`);
    await mission.runStage(stage);
  };
}

// ---- 14 activity exports (one per MissionStage) ---------------------------

export const activityIngest          = stageActivity("INGEST");
export const activityParse           = stageActivity("PARSE");
export const activityScoreR1         = stageActivity("SCORE_R1");
export const activityGate1           = stageActivity("GATE_1");
export const activityPhoneScreen     = stageActivity("PHONE_SCREEN");
export const activityNudge           = stageActivity("NUDGE");
export const activityScoreR2         = stageActivity("SCORE_R2");
export const activityAvatar          = stageActivity("AVATAR");
export const activityScoreR3         = stageActivity("SCORE_R3");
export const activitySendLeaderboard = stageActivity("SEND_LEADERBOARD");
export const activityGate2           = stageActivity("GATE_2");
export const activitySchedulePanel   = stageActivity("SCHEDULE_PANEL");
export const activityDecisionPack    = stageActivity("DECISION_PACK");
export const activitySelfPause       = stageActivity("SELF_PAUSE");

// ---- Cleanup activity (stop heartbeat, mark COMPLETED) --------------------

export async function activityCleanup(context: Context): Promise<void> {
  const runId = context.bindings.input as string;
  const mission = getLiveMission(runId);
  if (!mission) return;

  const hb = heartbeats.get(runId);
  if (hb) { hb.stop(); heartbeats.delete(runId); }

  await mission.markCompleted();
  context.log(`[df] mission ${runId} completed`);
}

// ---- Durable orchestrator -------------------------------------------------

export const missionOrchestrator = df.orchestrator(function* (context) {
  const input = context.df.getInput() as MissionInput;

  const runId: string = yield context.df.callActivity("activityInit", input);

  // 14 stages in mission order
  yield context.df.callActivity("activityIngest",          runId);
  yield context.df.callActivity("activityParse",           runId);
  yield context.df.callActivity("activityScoreR1",         runId);
  yield context.df.callActivity("activityGate1",           runId);
  yield context.df.callActivity("activityPhoneScreen",     runId);
  yield context.df.callActivity("activityNudge",           runId);
  yield context.df.callActivity("activityScoreR2",         runId);
  yield context.df.callActivity("activityAvatar",          runId);
  yield context.df.callActivity("activityScoreR3",         runId);
  yield context.df.callActivity("activitySendLeaderboard", runId);
  yield context.df.callActivity("activityGate2",           runId);
  yield context.df.callActivity("activitySchedulePanel",   runId);
  yield context.df.callActivity("activityDecisionPack",    runId);
  yield context.df.callActivity("activitySelfPause",       runId);

  yield context.df.callActivity("activityCleanup", runId);
  return runId;
});

// ---- HTTP starter ---------------------------------------------------------

export async function httpStart(context: Context, req: HttpRequest): Promise<void> {
  const client = df.getClient(context);
  const body: MissionInput = (req.body as MissionInput) ?? {
    tenantId: "default",
    goal: { topN: 3, jdId: "smaya-senior-backend-2026", excludedCandidates: [], skipStages: [] },
    resumesDir: "fixtures/resumes/pdf",
    budgetUsd: 5.0,
  };
  const instanceId = await client.startNew("missionOrchestrator", undefined, body);
  context.log(`[df] started orchestration ${instanceId}`);
  context.res = client.createCheckStatusResponse(context.bindingData.req, instanceId);
}
