// The 14-stage mission. Resume-safe: every stage transition writes the run record
// to Cosmos and emits an audit entry, so a restart picks up exactly where it left off.
//
// Why a hand-rolled state machine and not Durable Functions?
//   The spec mandates Durable Functions *locally* (§7 Module A). The Azure
//   Functions Core Tools host runs the orchestrator function via this same module
//   — see src/df-binding.ts for the host adapter. The orchestrator core logic
//   below is plain TS so it also runs under `tsx src/cli.ts --in-memory` for
//   reviewers without the Functions host.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateId, MaskedProfile, MissionGoal, MissionStage, RunRecord, Score, TenantId } from "@smaya/shared/schemas";
import { tracer } from "@smaya/shared/telemetry";
import { now, simToReal, sleep } from "@smaya/shared/time";
import { costLedger } from "@smaya/shared/cost";
import { repos } from "@smaya/data";
import { issueToken } from "@smaya/mcp-tools/oauth";
import { resumeParser } from "@smaya/mcp-tools/resume-parser";
import { voiceCall, type VoiceCallOutput } from "@smaya/mcp-tools/voice-call";
import { avatarInterview } from "@smaya/mcp-tools/avatar-interview";
import { slackPoster } from "@smaya/mcp-tools/slack-poster";
import { outlookScheduler } from "@smaya/mcp-tools/outlook-scheduler";
import { piiEval, biasEval, scoreStabilityEval } from "@smaya/evals";
import { Heartbeat } from "./heartbeat.js";
import { awaitGate, requestGate } from "./gates.js";
import { rankLeaderboardAll, scoreR1, scoreR2, scoreR3 } from "./scoring.js";
import { registerRun } from "./depth.js";
import { bus } from "./bus.js";

export interface MissionInput {
  tenantId: TenantId;
  goal: MissionGoal;
  resumesDir: string;
  budgetUsd?: number;
  panelMembers?: string[];
}

const DEFAULT_PANEL = ["alice@smaya.example.com", "bob@smaya.example.com"];

export class Mission {
  readonly run: RunRecord;
  private heartbeat?: Heartbeat;
  private aborted = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private candidates = new Map<CandidateId, MaskedProfile>();
  private r1: Score[] = [];
  private r2: Score[] = [];
  private r3: Score[] = [];
  private phoneOutputs = new Map<CandidateId, Extract<VoiceCallOutput, { status: "COMPLETED" }>>();
  private interventions = 0;

  constructor(private input: MissionInput) {
    const id = randomUUID();
    registerRun(id);
    const start = now();
    this.run = {
      id,
      tenantId: input.tenantId,
      goal: input.goal,
      goalVersion: 1,
      status: "RUNNING",
      stage: "INGEST",
      candidateIds: [],
      heartbeat: { lastTickAt: start, nextTickAt: start, cadenceMs: 60_000, driftMs: 0, skipCount: 0 },
      costUsd: 0,
      costCapUsd: input.budgetUsd ?? 5.0,
      startedAt: start,
      updatedAt: start,
    };
    costLedger.setCap(this.run.id, this.run.costCapUsd);
  }

  /** Drives the mission to completion (or pause/abort). */
  async run_(): Promise<void> {
    await this.transition("INGEST");
    this.heartbeat = new Heartbeat(this.run, async () => {
      // Per-tick budget check (rubric §6).
      if (costLedger.isAtSoftCap(this.run.id) && !this.paused) {
        await this.softBudgetPause();
      }
      await repos.putRun(this.run);
    });
    await this.heartbeat.start();

    try {
      await tracer.withSpan("mission.run", { runId: this.run.id, tenantId: this.run.tenantId }, async () => {
        await this.stageIngest();
        await this.stagePARSE();
        await this.stageSCORE_R1();
        await this.stageGATE_1();
        await this.stagePHONE_SCREEN_with_NUDGE();
        await this.stageSCORE_R2();
        if (!this.input.goal.skipStages.includes("AVATAR")) {
          await this.stageAVATAR();
        }
        await this.stageSCORE_R3();
        await this.stageSEND_LEADERBOARD();
        await this.stageGATE_2();
        await this.stageSCHEDULE_PANEL();
        await this.stageDECISION_PACK();
        await this.transition("SELF_PAUSE");
      });
      this.run.status = "COMPLETED";
      await repos.putRun(this.run);
      bus.emitRun({ type: "RUN_COMPLETED", runId: this.run.id, tenantId: this.run.tenantId, detail: {}, at: now() });
    } catch (err) {
      if (this.aborted) {
        this.run.status = "STOPPED";
        await repos.putRun(this.run);
        await this.writeAbortedDecisionPack(String((err as Error)?.message ?? err));
        bus.emitRun({ type: "RUN_ABORTED", runId: this.run.id, tenantId: this.run.tenantId, detail: { reason: String(err) }, at: now() });
        return;
      }
      this.run.status = "FAILED";
      await repos.appendAudit({
        id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
        type: "ERROR", detail: { message: String(err) }, at: now(),
      });
      throw err;
    } finally {
      this.heartbeat?.stop();
    }
  }

  // ---- DF adapter: run a single stage by name ----------------------------

  /** Called by the Azure Functions activity wrappers in df-binding.ts. */
  async runStage(stage: MissionStage): Promise<void> {
    switch (stage) {
      case "INGEST":          return this.stageIngest();
      case "PARSE":           return this.stagePARSE();
      case "SCORE_R1":        return this.stageSCORE_R1();
      case "GATE_1":          return this.stageGATE_1();
      case "PHONE_SCREEN":    return this.stagePHONE_SCREEN_with_NUDGE();
      case "NUDGE":           return; // driven internally by PHONE_SCREEN
      case "SCORE_R2":        return this.stageSCORE_R2();
      case "AVATAR":
        if (!this.input.goal.skipStages.includes("AVATAR")) {
          return this.stageAVATAR();
        }
        return;
      case "SCORE_R3":        return this.stageSCORE_R3();
      case "SEND_LEADERBOARD": return this.stageSEND_LEADERBOARD();
      case "GATE_2":          return this.stageGATE_2();
      case "SCHEDULE_PANEL":  return this.stageSCHEDULE_PANEL();
      case "DECISION_PACK":   return this.stageDECISION_PACK();
      case "SELF_PAUSE":      await this.transition("SELF_PAUSE"); return;
    }
  }

  /** Start heartbeat — exposed so df-binding can manage it outside run_(). */
  startHeartbeat(): Heartbeat {
    const hb = new Heartbeat(this.run, async () => {
      if (costLedger.isAtSoftCap(this.run.id) && !this.paused) {
        await this.softBudgetPause();
      }
      await repos.putRun(this.run);
    });
    void hb.start();
    return hb;
  }

  /** Mark run COMPLETED — exposed so df-binding can finalise outside run_(). */
  async markCompleted(): Promise<void> {
    this.run.status = "COMPLETED";
    await repos.putRun(this.run);
    bus.emitRun({ type: "RUN_COMPLETED", runId: this.run.id, tenantId: this.run.tenantId, detail: {}, at: now() });
  }

  // ---- Stages ------------------------------------------------------------

  private async stageIngest(): Promise<void> {
    await this.checkPaused();
    const dir = this.input.resumesDir;
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
    const ids: CandidateId[] = [];
    for (const f of files) {
      const m = f.match(/^(c\d{2,})-/);
      if (m && m[1]) ids.push(m[1] as CandidateId);
    }
    this.run.candidateIds = ids;
    await repos.putRun(this.run);
  }

  private async stagePARSE(): Promise<void> {
    await this.transition("PARSE");
    await this.checkPaused();
    // Pre-side-effect: PII eval BEFORE first candidates write.
    const piiCtx = { runId: this.run.id, tenantId: this.run.tenantId };
    const piiReport = await piiEval.run(piiCtx, { candidates: [] });
    await this.recordEval("PII_MASKING", piiReport);
    if (!piiReport.passed) {
      throw new Error(`PII eval failed: score=${piiReport.score}`);
    }

    const token = issueToken({ tenantId: this.run.tenantId, tool: "resume-parser", scopes: ["resume:read"] });
    for (const id of this.run.candidateIds) {
      await this.checkPaused();
      const path = pdfPathFor(this.input.resumesDir, id);
      const out = await resumeParser({
        runId: this.run.id, tenantId: this.run.tenantId, token,
        scope: "resume:read", gateClearance: true,
        idempotencyParts: ["parse", id], costUsd: 0.002,
      }, { pdfPath: path, candidateId: id });
      this.candidates.set(id, out.masked);
      await repos.putCandidate(this.run.tenantId, out.masked);
    }
  }

  private async stageSCORE_R1(): Promise<void> {
    await this.transition("SCORE_R1");
    for (const [id, profile] of this.candidates) {
      await this.checkPaused();
      const score = await scoreR1({ profile, jdId: this.input.goal.jdId });
      this.r1.push(score);
      await repos.putScore(this.run.tenantId, this.run.id, score);
    }
  }

  private async stageGATE_1(): Promise<void> {
    await this.transition("GATE_1");
    this.run.status = "AWAITING_GATE";
    await repos.putRun(this.run);
    await requestGate(this.run.id, this.run.tenantId, "GATE_1");
    await awaitGate(this.run.id, "GATE_1");
    this.run.status = "RUNNING";
    await repos.putRun(this.run);
  }

  private async stagePHONE_SCREEN_with_NUDGE(): Promise<void> {
    await this.transition("PHONE_SCREEN");
    // Pre-side-effect: score-stability eval before any dial-out.
    const profilesForEval = [...this.candidates.values()].map((p) => ({
      id: p.id, summary: p.summary, skills: p.skills, yearsTotal: p.yearsTotal,
    }));
    const stab = await scoreStabilityEval.run({ runId: this.run.id, tenantId: this.run.tenantId }, {
      scores: this.r1, profiles: profilesForEval, jdId: this.input.goal.jdId,
    });
    await this.recordEval("SCORE_STABILITY", stab);
    if (!stab.passed) throw new Error(`SCORE_STABILITY eval failed: ${stab.score}`);

    const token = issueToken({ tenantId: this.run.tenantId, tool: "voice-call", scopes: ["voice:call"] });
    for (const id of this.candidates.keys()) {
      if (this.input.goal.excludedCandidates.includes(id)) continue;
      await this.checkPaused();
      const completed = await this.dialWithNudge(id, token);
      if (completed) this.phoneOutputs.set(id, completed);
    }
  }

  private async dialWithNudge(id: CandidateId, token: string): Promise<Extract<VoiceCallOutput, { status: "COMPLETED" }> | null> {
    let attempt = 1;
    while (attempt <= 3) {
      await this.checkPaused();
      const out = await voiceCall({
        runId: this.run.id, tenantId: this.run.tenantId, token,
        scope: "voice:call", gateClearance: true,
        idempotencyParts: ["voice", id, attempt], costUsd: 0.05,
      }, { candidateId: id, attempt, jdId: this.input.goal.jdId });
      if (out.status === "COMPLETED") return out;
      // NO_ANSWER → nudge: backoff (real cost-cap respecting wait), retry.
      await this.transition("NUDGE");
      await sleep(simToReal(out.nextRetryHintMs));
      await this.transition("PHONE_SCREEN");
      attempt++;
    }
    return null;
  }

  private async stageSCORE_R2(): Promise<void> {
    await this.transition("SCORE_R2");
    for (const id of this.candidates.keys()) {
      const phone = this.phoneOutputs.get(id);
      if (!phone) continue;
      await this.checkPaused();
      const profile = this.candidates.get(id)!;
      const r1 = this.r1.find((s) => s.candidateId === id)!;
      const score = await scoreR2({ profile, r1, phone, jdId: this.input.goal.jdId });
      this.r2.push(score);
      await repos.putScore(this.run.tenantId, this.run.id, score);
    }
  }

  private async stageAVATAR(): Promise<void> {
    await this.transition("AVATAR");
    const token = issueToken({ tenantId: this.run.tenantId, tool: "avatar-interview", scopes: ["interview:run"] });
    for (const score of this.r2) {
      await this.checkPaused();
      const out = await avatarInterview({
        runId: this.run.id, tenantId: this.run.tenantId, token,
        scope: "interview:run", gateClearance: true,
        idempotencyParts: ["avatar", score.candidateId], costUsd: 0.10,
      }, { candidateId: score.candidateId, jdId: this.input.goal.jdId, topics: ["systems-design", "agentic-systems"] });
      const profile = this.candidates.get(score.candidateId)!;
      const final = await scoreR3({ profile, r2: score, avatar: out, jdId: this.input.goal.jdId });
      this.r3.push(final);
      await repos.putScore(this.run.tenantId, this.run.id, final);
    }
  }

  private async stageSCORE_R3(): Promise<void> {
    await this.transition("SCORE_R3");
    if (this.r3.length === 0) {
      // Either AVATAR was skipped via DEVIATE or all phone screens failed.
      // Promote R2 (or R1) into R3 slots so the leaderboard still has signal.
      const fallback = this.r2.length ? this.r2 : this.r1;
      this.r3 = fallback.map((s) => ({ ...s, round: "R3" }));
      for (const s of this.r3) await repos.putScore(this.run.tenantId, this.run.id, s);
    }
  }

  private async stageSEND_LEADERBOARD(): Promise<void> {
    await this.transition("SEND_LEADERBOARD");
    const all = rankLeaderboardAll(this.r3);
    const topN = this.input.goal.topN;
    const top = all.filter((r) => r.rank <= topN);

    // Pre-side-effect: bias eval BEFORE Slack/email send.
    const bias = await biasEval.run({ runId: this.run.id, tenantId: this.run.tenantId }, { leaderboard: all, topN });
    await this.recordEval("LEADERBOARD_BIAS", bias);
    if (!bias.passed) throw new Error(`LEADERBOARD_BIAS eval failed: ratio=${bias.score}`);

    const slackToken = issueToken({ tenantId: this.run.tenantId, tool: "slack-poster", scopes: ["slack:post"] });
    const outlookToken = issueToken({ tenantId: this.run.tenantId, tool: "outlook-scheduler", scopes: ["outlook:write"] });

    const blocks = top.map((t) => ({ rank: t.rank, candidateId: t.candidateId, composite: t.composite }));
    await slackPoster({
      runId: this.run.id, tenantId: this.run.tenantId, token: slackToken,
      scope: "slack:post", gateClearance: true,
      idempotencyParts: ["slack-leaderboard", this.run.id], costUsd: 0.001,
    }, { channel: "#hiring-panel", text: `Smaya leaderboard for run ${this.run.id}: top-${topN}`, blocks });

    await outlookScheduler({
      runId: this.run.id, tenantId: this.run.tenantId, token: outlookToken,
      scope: "outlook:write", gateClearance: true,
      idempotencyParts: ["email-leaderboard", this.run.id], costUsd: 0.001,
    }, {
      op: "send-email",
      to: this.input.panelMembers ?? DEFAULT_PANEL,
      subject: `Smaya leaderboard — run ${this.run.id}`,
      body: top.map((t) => `#${t.rank} ${t.candidateId} (${t.composite}/100): ${t.rationale}`).join("\n"),
    });
  }

  private async stageGATE_2(): Promise<void> {
    await this.transition("GATE_2");
    this.run.status = "AWAITING_GATE";
    await repos.putRun(this.run);
    await requestGate(this.run.id, this.run.tenantId, "GATE_2");
    await awaitGate(this.run.id, "GATE_2");
    this.run.status = "RUNNING";
    await repos.putRun(this.run);
  }

  private async stageSCHEDULE_PANEL(): Promise<void> {
    await this.transition("SCHEDULE_PANEL");
    const top = rankLeaderboardAll(this.r3).slice(0, this.input.goal.topN);
    const winner = top[0];
    if (!winner) return;
    const token = issueToken({ tenantId: this.run.tenantId, tool: "outlook-scheduler", scopes: ["outlook:write"] });
    const startsAt = Date.now() + simToReal(24 * 60 * 60 * 1000);
    const endsAt = startsAt + simToReal(60 * 60 * 1000);
    await outlookScheduler({
      runId: this.run.id, tenantId: this.run.tenantId, token,
      scope: "outlook:write", gateClearance: true,
      idempotencyParts: ["calendar", this.run.id, winner.candidateId], costUsd: 0.001,
    }, {
      op: "create-event",
      attendees: [...(this.input.panelMembers ?? DEFAULT_PANEL), `${winner.candidateId}@candidate.example.com`],
      subject: `Final panel — ${winner.candidateId} for ${this.input.goal.jdId}`,
      startsAt,
      endsAt,
      description: `Composite ${winner.composite}/100\n${winner.rationale}`,
    });
    this.scheduledPanel = { candidateId: winner.candidateId, startsAt, endsAt, panelMembers: this.input.panelMembers ?? DEFAULT_PANEL };
  }
  private scheduledPanel?: { candidateId: string; startsAt: number; endsAt: number; panelMembers: string[] };

  private async stageDECISION_PACK(): Promise<void> {
    await this.transition("DECISION_PACK");
    const all = rankLeaderboardAll(this.r3);
    const evals = await repos.listEvals(this.run.tenantId, this.run.id);
    const interventions = await repos.listInterventions(this.run.tenantId, this.run.id);
    await repos.putDecisionPack({
      runId: this.run.id,
      tenantId: this.run.tenantId,
      jdId: this.input.goal.jdId,
      topN: this.input.goal.topN,
      leaderboard: all.slice(0, this.input.goal.topN),
      panelSlot: this.scheduledPanel ? {
        candidateId: this.scheduledPanel.candidateId as CandidateId,
        startsAt: this.scheduledPanel.startsAt,
        endsAt: this.scheduledPanel.endsAt,
        panelMembers: this.scheduledPanel.panelMembers,
      } : undefined,
      costUsd: costLedger.total(this.run.id),
      durationMs: now() - this.run.startedAt,
      evalSummary: evals.map((e) => ({ name: e.evalName, score: e.score, threshold: e.threshold, passed: e.passed })),
      interventionCount: interventions.length,
      status: "COMPLETED",
      generatedAt: now(),
    });
  }

  // ---- Lifecycle helpers --------------------------------------------------

  private async transition(stage: MissionStage): Promise<void> {
    const from = this.run.stage;
    this.run.stage = stage;
    this.run.updatedAt = now();
    await repos.putRun(this.run);
    await repos.appendAudit({
      id: randomUUID(),
      runId: this.run.id,
      tenantId: this.run.tenantId,
      type: "STAGE_TRANSITION",
      detail: { from, to: stage },
      at: now(),
    });
    bus.emitRun({ type: "STAGE_TRANSITION", runId: this.run.id, tenantId: this.run.tenantId, detail: { from, to: stage }, at: now() });
  }

  private async recordEval(name: "PII_MASKING" | "SCORE_STABILITY" | "LEADERBOARD_BIAS", report: { passed: boolean; score: number; threshold: number; details: unknown }): Promise<void> {
    await repos.putEval({
      id: randomUUID(),
      runId: this.run.id,
      tenantId: this.run.tenantId,
      evalName: name,
      score: report.score,
      threshold: report.threshold,
      passed: report.passed,
      details: report.details,
      at: now(),
    });
    bus.emitRun({
      type: "EVAL_RESULT",
      runId: this.run.id,
      tenantId: this.run.tenantId,
      detail: { name, ...report },
      at: now(),
    });
  }

  private async softBudgetPause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.run.status = "PAUSED";
    this.run.pausedReason = `budget soft-cap hit ($${costLedger.total(this.run.id).toFixed(3)} of $${this.run.costCapUsd})`;
    await repos.putRun(this.run);
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "BUDGET_PAUSE", detail: { totalUsd: costLedger.total(this.run.id) }, at: now(),
    });
    bus.emitRun({ type: "BUDGET_PAUSE", runId: this.run.id, tenantId: this.run.tenantId, detail: { totalUsd: costLedger.total(this.run.id) }, at: now() });
  }

  private async checkPaused(): Promise<void> {
    if (this.aborted) throw new Error("aborted by intervention");
    if (!this.paused) return;
    await new Promise<void>((res) => this.resumeWaiters.push(res));
  }

  private async writeAbortedDecisionPack(reason: string): Promise<void> {
    await repos.putDecisionPack({
      runId: this.run.id,
      tenantId: this.run.tenantId,
      jdId: this.input.goal.jdId,
      topN: this.input.goal.topN,
      leaderboard: rankLeaderboardAll(this.r3).slice(0, this.input.goal.topN),
      costUsd: costLedger.total(this.run.id),
      durationMs: now() - this.run.startedAt,
      evalSummary: (await repos.listEvals(this.run.tenantId, this.run.id)).map((e) => ({
        name: e.evalName, score: e.score, threshold: e.threshold, passed: e.passed,
      })),
      interventionCount: this.interventions,
      status: "ABORTED",
      generatedAt: now(),
    });
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "ERROR", detail: { reason }, at: now(),
    });
  }

  // ---- Public intervention surface (called by intervention-api) ----------

  async pause(reason: string, operator: string): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.run.status = "PAUSED";
    this.run.pausedReason = reason;
    await repos.putRun(this.run);
    bus.emitRun({ type: "RUN_PAUSED", runId: this.run.id, tenantId: this.run.tenantId, detail: { reason, by: operator }, at: now() });
  }
  async resume(operator: string): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    delete this.run.pausedReason;
    this.run.status = "RUNNING";
    await repos.putRun(this.run);
    const w = this.resumeWaiters.splice(0);
    for (const r of w) r();
    bus.emitRun({ type: "RUN_RESUMED", runId: this.run.id, tenantId: this.run.tenantId, detail: { by: operator }, at: now() });
  }
  async stop(operator: string, reason: string): Promise<void> {
    this.aborted = true;
    this.paused = false;
    const w = this.resumeWaiters.splice(0);
    for (const r of w) r();
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "INTERVENTION", detail: { intent: "STOP", reason }, operator, at: now(),
    });
  }
  async addContext(text: string, operator: string): Promise<{ diff: { added: string } }> {
    this.interventions++;
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "INTERVENTION", detail: { intent: "ADD_CONTEXT", text }, operator, at: now(),
    });
    return { diff: { added: text } };
  }
  async updateGoal(patch: Partial<MissionGoal>, operator: string): Promise<{ diff: Partial<MissionGoal>; version: number }> {
    const before = { ...this.input.goal };
    this.input.goal = { ...this.input.goal, ...patch };
    this.run.goal = this.input.goal;
    this.run.goalVersion++;
    await repos.putRun(this.run);
    await repos.putGoalVersion({
      id: randomUUID(),
      tenantId: this.run.tenantId,
      runId: this.run.id,
      version: this.run.goalVersion,
      goal: this.input.goal,
      at: now(),
    });
    this.interventions++;
    return { diff: diffGoals(before, this.input.goal), version: this.run.goalVersion };
  }
  async overrideRejectCandidate(candidateId: CandidateId, operator: string, rationale: string): Promise<void> {
    this.input.goal.excludedCandidates.push(candidateId);
    this.run.goal = this.input.goal;
    this.r3 = this.r3.filter((s) => s.candidateId !== candidateId);
    this.r2 = this.r2.filter((s) => s.candidateId !== candidateId);
    this.r1 = this.r1.filter((s) => s.candidateId !== candidateId);
    await repos.putRun(this.run);
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "INTERVENTION", detail: { intent: "OVERRIDE_DECISION", kind: "reject_candidate", candidateId, rationale },
      operator, at: now(),
    });
    this.interventions++;
  }
  async deviate(skipStage: MissionStage, operator: string, rationale: string): Promise<void> {
    this.input.goal.skipStages.push(skipStage);
    this.run.goal = this.input.goal;
    await repos.putRun(this.run);
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "INTERVENTION", detail: { intent: "DEVIATE", skipStage, rationale }, operator, at: now(),
    });
    this.interventions++;
  }
  async replayAction(kind: "score" | "parse", candidateId: CandidateId, operator: string): Promise<void> {
    // Re-run by clearing the cached idempotency value for that key and re-invoking.
    // For simplicity we just re-score (parse re-run is more involved and rarely useful).
    if (kind === "score") {
      const profile = this.candidates.get(candidateId);
      if (profile) {
        const fresh = await scoreR1({ profile, jdId: this.input.goal.jdId });
        this.r1 = this.r1.filter((s) => s.candidateId !== candidateId).concat(fresh);
        await repos.putScore(this.run.tenantId, this.run.id, fresh);
      }
    }
    await repos.appendAudit({
      id: randomUUID(), runId: this.run.id, tenantId: this.run.tenantId,
      type: "INTERVENTION", detail: { intent: "REPLAY_ACTION", kind, candidateId }, operator, at: now(),
    });
    this.interventions++;
  }
  status(): { stage: MissionStage; status: RunRecord["status"]; costUsd: number; etaSec: number } {
    return {
      stage: this.run.stage,
      status: this.run.status,
      costUsd: costLedger.total(this.run.id),
      etaSec: this.estimateEtaSec(),
    };
  }
  private estimateEtaSec(): number {
    // Naive: count remaining stages × active cadence in real seconds.
    const order: MissionStage[] = [
      "INGEST", "PARSE", "SCORE_R1", "GATE_1", "PHONE_SCREEN", "NUDGE",
      "SCORE_R2", "AVATAR", "SCORE_R3", "SEND_LEADERBOARD", "GATE_2",
      "SCHEDULE_PANEL", "DECISION_PACK", "SELF_PAUSE",
    ];
    const idx = order.indexOf(this.run.stage);
    return Math.max(0, order.length - idx) * (simToReal(60_000) / 1000);
  }
}

function pdfPathFor(dir: string, id: CandidateId): string {
  const files = readdirSync(dir);
  const f = files.find((x) => x.startsWith(`${id}-`) && x.toLowerCase().endsWith(".pdf"));
  if (!f) throw new Error(`no pdf for ${id} in ${dir}`);
  return resolve(dir, f);
}

function diffGoals(a: MissionGoal, b: MissionGoal): Partial<MissionGoal> {
  const out: Partial<MissionGoal> = {};
  if (a.topN !== b.topN) out.topN = b.topN;
  if (JSON.stringify(a.excludedCandidates) !== JSON.stringify(b.excludedCandidates)) out.excludedCandidates = b.excludedCandidates;
  if (JSON.stringify(a.skipStages) !== JSON.stringify(b.skipStages)) out.skipStages = b.skipStages;
  return out;
}

// ---- Run registry (so the API can find a live mission) -----------------

const live = new Map<string, Mission>();
export function registerLiveMission(m: Mission): void {
  live.set(m.run.id, m);
}
export function getLiveMission(runId: string): Mission | undefined {
  return live.get(runId);
}
export function listLiveMissions(): Mission[] {
  return [...live.values()];
}
