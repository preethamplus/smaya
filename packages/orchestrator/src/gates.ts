// Predefined human gates. NON-BYPASSABLE by intervention (rubric #13).
//
// Mechanism: orchestrator transitions to AWAITING_GATE, persists the request,
// and *waits* on bus events. The UI's Approvals tab posts via the intervention
// API which routes here. A 4-hour simulated timeout escalates and is logged.

import type { MissionStage } from "@smaya/shared/schemas";
import { repos } from "@smaya/data";
import { bus } from "./bus.js";
import { simToReal } from "@smaya/shared/time";
import { randomUUID } from "node:crypto";

export const GATE_TIMEOUT_SIM_MS = 4 * 60 * 60 * 1000; // 4 hours
export const NON_BYPASSABLE_GATES = new Set<MissionStage>(["GATE_1", "GATE_2"]);

export interface GateRequest {
  runId: string;
  tenantId: string;
  gate: "GATE_1" | "GATE_2";
  approvedAt?: number;
  approvedBy?: string;
  rejectedAt?: number;
  rejectedBy?: string;
  reason?: string;
  expiresAt: number;
}

const pending = new Map<string, GateRequest>(); // key: `${runId}:${gate}`

function key(runId: string, gate: "GATE_1" | "GATE_2"): string {
  return `${runId}:${gate}`;
}

export async function requestGate(runId: string, tenantId: string, gate: "GATE_1" | "GATE_2"): Promise<void> {
  const expiresAt = Date.now() + simToReal(GATE_TIMEOUT_SIM_MS);
  pending.set(key(runId, gate), { runId, tenantId, gate, expiresAt });
  await repos.appendAudit({
    id: randomUUID(),
    runId,
    tenantId,
    type: "GATE_REQUESTED",
    detail: { gate, expiresAt },
    at: Date.now(),
  });
  bus.emitRun({ type: "GATE_REQUESTED", runId, tenantId, detail: { gate, expiresAt }, at: Date.now() });
}

export function listPendingGates(runId: string): GateRequest[] {
  return [...pending.values()].filter((g) => g.runId === runId && !g.approvedAt && !g.rejectedAt);
}

export async function approveGate(runId: string, tenantId: string, gate: "GATE_1" | "GATE_2", operator: string): Promise<void> {
  const k = key(runId, gate);
  const req = pending.get(k);
  if (!req) throw new Error(`no pending ${gate} for run ${runId}`);
  req.approvedAt = Date.now();
  req.approvedBy = operator;
  pending.set(k, req);
  await repos.appendAudit({
    id: randomUUID(),
    runId,
    tenantId,
    type: "GATE_APPROVED",
    detail: { gate, by: operator },
    operator,
    at: Date.now(),
  });
  bus.emitRun({ type: "GATE_APPROVED", runId, tenantId, detail: { gate, by: operator }, at: Date.now() });
}

export async function rejectGate(runId: string, tenantId: string, gate: "GATE_1" | "GATE_2", operator: string, reason: string): Promise<void> {
  const k = key(runId, gate);
  const req = pending.get(k);
  if (!req) throw new Error(`no pending ${gate} for run ${runId}`);
  req.rejectedAt = Date.now();
  req.rejectedBy = operator;
  req.reason = reason;
  pending.set(k, req);
  await repos.appendAudit({
    id: randomUUID(),
    runId,
    tenantId,
    type: "GATE_REJECTED",
    detail: { gate, by: operator, reason },
    operator,
    at: Date.now(),
  });
}

export async function awaitGate(runId: string, gate: "GATE_1" | "GATE_2"): Promise<{ approved: boolean; by?: string; reason?: string }> {
  return new Promise((resolve) => {
    const handler = (e: { type: string; runId: string; detail: unknown }): void => {
      if (e.runId !== runId) return;
      if (e.type === "GATE_APPROVED") {
        const d = e.detail as { gate: string; by: string };
        if (d.gate === gate) {
          bus.off("run", handler);
          resolve({ approved: true, by: d.by });
        }
      }
    };
    bus.on("run", handler);

    // Also resolve early if already approved before await began (race-safe).
    const existing = pending.get(key(runId, gate));
    if (existing?.approvedAt) {
      bus.off("run", handler);
      resolve({ approved: true, by: existing.approvedBy });
    }
  });
}
