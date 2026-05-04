// Typed repos on top of the Store. Each repo encapsulates a container + its schema.
// Orchestrator code uses repos, not the raw Store, except for the diagnostic snapshot.

import type {
  AuditEntry,
  DecisionPack,
  EvalResult,
  InterventionRecord,
  MaskedProfile,
  McpInvocation,
  RunRecord,
  Score,
  TenantId,
} from "@smaya/shared/schemas";
import {
  AuditEntry as AuditEntrySchema,
  DecisionPack as DecisionPackSchema,
  EvalResult as EvalResultSchema,
  InterventionRecord as InterventionRecordSchema,
  MaskedProfile as MaskedProfileSchema,
  McpInvocation as McpInvocationSchema,
  RunRecord as RunRecordSchema,
  Score as ScoreSchema,
} from "@smaya/shared/schemas";
import { getStore, type Store } from "./store.js";
import { CONTAINERS } from "./containers.js";

export class Repos {
  constructor(private store: Store = getStore()) {}

  // ---- Run record --------------------------------------------------------
  async putRun(r: RunRecord): Promise<void> {
    RunRecordSchema.parse(r);
    await this.store.upsert(CONTAINERS.agentRuns, { ...r });
  }
  async getRun(tenantId: TenantId, runId: string): Promise<RunRecord | undefined> {
    const item = await this.store.get(CONTAINERS.agentRuns, tenantId, runId);
    return item ? RunRecordSchema.parse(item) : undefined;
  }
  async listRuns(tenantId: TenantId): Promise<RunRecord[]> {
    const rows = await this.store.query(CONTAINERS.agentRuns, { tenantId });
    return rows.map((r) => RunRecordSchema.parse(r));
  }

  // ---- Candidate (masked profile) ----------------------------------------
  async putCandidate(tenantId: TenantId, profile: MaskedProfile): Promise<void> {
    MaskedProfileSchema.parse(profile);
    // The store's PII assertion runs on the candidates container automatically.
    await this.store.upsert(CONTAINERS.candidates, { ...profile, tenantId });
  }
  async getCandidate(tenantId: TenantId, candidateId: string): Promise<MaskedProfile | undefined> {
    const item = await this.store.get(CONTAINERS.candidates, tenantId, candidateId);
    if (!item) return undefined;
    const { tenantId: _t, ...rest } = item;
    return MaskedProfileSchema.parse(rest);
  }
  async listCandidates(tenantId: TenantId): Promise<MaskedProfile[]> {
    const rows = await this.store.query(CONTAINERS.candidates, { tenantId });
    return rows.map((r) => {
      const { tenantId: _t, ...rest } = r;
      return MaskedProfileSchema.parse(rest);
    });
  }

  // ---- Score (per round per candidate) -----------------------------------
  async putScore(tenantId: TenantId, runId: string, score: Score): Promise<void> {
    ScoreSchema.parse(score);
    const id = `${runId}:${score.candidateId}:${score.round}`;
    await this.store.upsert(CONTAINERS.evalResults, {
      id,
      tenantId,
      kind: "score",
      runId,
      ...score,
    });
  }
  async listScores(tenantId: TenantId, runId: string, round?: Score["round"]): Promise<Score[]> {
    const rows = await this.store.query(CONTAINERS.evalResults, {
      tenantId,
      filter: (r) => r["kind"] === "score" && r["runId"] === runId && (!round || r["round"] === round),
    });
    return rows.map((r) => {
      const { id: _id, tenantId: _t, kind: _k, runId: _r, ...rest } = r;
      return ScoreSchema.parse(rest);
    });
  }

  // ---- Audit -------------------------------------------------------------
  async appendAudit(entry: AuditEntry): Promise<void> {
    AuditEntrySchema.parse(entry);
    await this.store.upsert(CONTAINERS.auditLog, { ...entry });
  }
  async listAudit(tenantId: TenantId, runId: string): Promise<AuditEntry[]> {
    const rows = await this.store.query(CONTAINERS.auditLog, {
      tenantId,
      filter: (r) => r["runId"] === runId,
    });
    return rows
      .map((r) => AuditEntrySchema.parse(r))
      .sort((a, b) => a.at - b.at);
  }

  // ---- MCP call log ------------------------------------------------------
  async logMcp(inv: McpInvocation): Promise<void> {
    McpInvocationSchema.parse(inv);
    await this.store.upsert(CONTAINERS.mcpCallLog, { ...inv });
  }
  async listMcp(tenantId: TenantId, runId: string): Promise<McpInvocation[]> {
    const rows = await this.store.query(CONTAINERS.mcpCallLog, {
      tenantId,
      filter: (r) => r["runId"] === runId,
    });
    return rows
      .map((r) => McpInvocationSchema.parse(r))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  // ---- Cost ledger -------------------------------------------------------
  async logCost(item: { id: string; tenantId: string; runId: string; source: string; usd: number; at: number }): Promise<void> {
    await this.store.upsert(CONTAINERS.costLedger, item);
  }
  async listCost(tenantId: TenantId, runId: string): Promise<Array<{ source: string; usd: number; at: number }>> {
    const rows = await this.store.query(CONTAINERS.costLedger, {
      tenantId,
      filter: (r) => r["runId"] === runId,
    });
    return rows.map((r) => ({
      source: String(r["source"]),
      usd: Number(r["usd"]),
      at: Number(r["at"]),
    }));
  }

  // ---- Eval results ------------------------------------------------------
  async putEval(e: EvalResult): Promise<void> {
    EvalResultSchema.parse(e);
    await this.store.upsert(CONTAINERS.evalResults, { ...e, kind: "eval" });
  }
  async listEvals(tenantId: TenantId, runId: string): Promise<EvalResult[]> {
    const rows = await this.store.query(CONTAINERS.evalResults, {
      tenantId,
      filter: (r) => r["kind"] === "eval" && r["runId"] === runId,
    });
    return rows.map((r) => {
      const { kind: _k, ...rest } = r;
      return EvalResultSchema.parse(rest);
    });
  }

  // ---- Goal versions -----------------------------------------------------
  async putGoalVersion(item: { id: string; tenantId: string; runId: string; version: number; goal: unknown; at: number; reason?: string }): Promise<void> {
    await this.store.upsert(CONTAINERS.goalVersions, item);
  }
  async listGoalVersions(tenantId: TenantId, runId: string): Promise<Array<{ version: number; goal: unknown; at: number; reason?: string }>> {
    const rows = await this.store.query(CONTAINERS.goalVersions, {
      tenantId,
      filter: (r) => r["runId"] === runId,
    });
    return rows
      .map((r) => ({
        version: Number(r["version"]),
        goal: r["goal"],
        at: Number(r["at"]),
        reason: r["reason"] as string | undefined,
      }))
      .sort((a, b) => a.version - b.version);
  }

  // ---- Interventions -----------------------------------------------------
  async logIntervention(rec: InterventionRecord): Promise<void> {
    InterventionRecordSchema.parse(rec);
    await this.store.upsert(CONTAINERS.interventions, { ...rec });
  }
  async listInterventions(tenantId: TenantId, runId: string): Promise<InterventionRecord[]> {
    const rows = await this.store.query(CONTAINERS.interventions, {
      tenantId,
      filter: (r) => r["runId"] === runId,
    });
    return rows
      .map((r) => InterventionRecordSchema.parse(r))
      .sort((a, b) => a.at - b.at);
  }

  // ---- Decision pack -----------------------------------------------------
  async putDecisionPack(pack: DecisionPack): Promise<void> {
    DecisionPackSchema.parse(pack);
    await this.store.upsert(CONTAINERS.decisionPacks, { ...pack, id: pack.runId });
  }
  async getDecisionPack(tenantId: TenantId, runId: string): Promise<DecisionPack | undefined> {
    const item = await this.store.get(CONTAINERS.decisionPacks, tenantId, runId);
    if (!item) return undefined;
    const { id: _id, ...rest } = item;
    return DecisionPackSchema.parse(rest);
  }
}

export const repos = new Repos();
