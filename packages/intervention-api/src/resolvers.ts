import type { CandidateId, InterventionIntent, MissionStage } from "@smaya/shared/schemas";
import { repos } from "@smaya/data";
import { getLiveMission, listLiveMissions, bus, listPendingGates, approveGate, rejectGate } from "@smaya/orchestrator";
import { getOutlookEmails, getOutlookEvents, getSlackMessages } from "@smaya/mcp-tools/mock-servers";
import { randomUUID } from "node:crypto";
import { validateIntervention } from "./allowlist.js";

export const resolvers = {
  Query: {
    runs: async () => listLiveMissions().map(toStatus),
    run: async (_: unknown, { runId }: { runId: string }) => {
      const m = getLiveMission(runId);
      return m ? toStatus(m) : null;
    },
    audit: async (_: unknown, { runId }: { runId: string }) => {
      const m = getLiveMission(runId);
      if (!m) return [];
      return repos.listAudit(m.run.tenantId, runId);
    },
    interventions: async (_: unknown, { runId }: { runId: string }) => {
      const m = getLiveMission(runId);
      if (!m) return [];
      return repos.listInterventions(m.run.tenantId, runId);
    },
    decisionPack: async (_: unknown, { runId }: { runId: string }) => {
      const m = getLiveMission(runId);
      if (!m) return null;
      return repos.getDecisionPack(m.run.tenantId, runId);
    },
    slackMessages: async () => getSlackMessages(),
    outlookEmails: async () => getOutlookEmails(),
    outlookEvents: async () => getOutlookEvents(),
  },
  Mutation: {
    approveGate: async (_: unknown, { runId, gate, operator }: { runId: string; gate: string; operator: string }) => {
      const m = getLiveMission(runId);
      if (!m) throw new Error("run not found");
      if (gate !== "GATE_1" && gate !== "GATE_2") throw new Error("invalid gate");
      await approveGate(runId, m.run.tenantId, gate, operator);
      return true;
    },
    rejectGate: async (_: unknown, { runId, gate, operator, reason }: { runId: string; gate: string; operator: string; reason: string }) => {
      const m = getLiveMission(runId);
      if (!m) throw new Error("run not found");
      if (gate !== "GATE_1" && gate !== "GATE_2") throw new Error("invalid gate");
      await rejectGate(runId, m.run.tenantId, gate, operator, reason);
      return true;
    },
    interveneRun: async (
      _: unknown,
      args: {
        runId: string;
        intent: InterventionIntent;
        payload: unknown;
        rationale?: string;
        operator: string;
        confirmed?: boolean;
      },
    ) => {
      const m = getLiveMission(args.runId);
      if (!m) throw new Error("run not found");

      // GraphQL nullable strings come through as null; normalize to undefined.
      const rationale = args.rationale ?? undefined;
      const v = validateIntervention(args.intent, args.payload, rationale);
      const auditId = randomUUID();

      if (!v.ok) {
        await repos.logIntervention({
          id: auditId,
          runId: args.runId,
          tenantId: m.run.tenantId,
          intent: args.intent,
          payload: args.payload,
          rationale: rationale,
          operator: args.operator,
          accepted: false,
          reason: v.reason,
          at: Date.now(),
        });
        return { accepted: false, requiresConfirmation: false, reason: v.reason, auditId };
      }
      // Confirmation gate for mutating intents.
      if (v.requireConfirmation && !args.confirmed) {
        return {
          accepted: false,
          requiresConfirmation: true,
          diff: v.payload,
          reason: "confirmation required",
          auditId,
        };
      }

      let diff: unknown = undefined;
      const operator = args.operator;
      switch (args.intent) {
        case "STATUS_QUERY":
          diff = m.status();
          break;
        case "ADD_CONTEXT":
          diff = await m.addContext((v.payload as { context: string }).context, operator);
          break;
        case "UPDATE_GOAL":
          diff = await m.updateGoal(v.payload as { topN?: number }, operator);
          break;
        case "PAUSE":
          await m.pause("operator pause", operator);
          break;
        case "RESUME":
          await m.resume(operator);
          break;
        case "STOP":
          await m.stop(operator, (v.payload as { reason?: string } | undefined)?.reason ?? "operator stop");
          break;
        case "OVERRIDE_DECISION": {
          const p = v.payload as { kind: "reject_candidate"; target: string };
          // skip_gate is already refused upstream
          // Try to resolve "Krithika" → c04 by looking at candidate names? We only store masked.
          // Convention: operators pass either an id "c04" OR a known token; we accept candidate id directly.
          const target = p.target.match(/^c\d{2,}$/) ? p.target : await idFromName(m, p.target);
          if (target) await m.overrideRejectCandidate(target as CandidateId, operator, rationale ?? "");
          else throw new Error(`could not resolve candidate "${p.target}"`);
          diff = { rejected: target };
          break;
        }
        case "REPLAY_ACTION": {
          const p = v.payload as { kind: "score" | "parse"; candidateId: CandidateId };
          await m.replayAction(p.kind, p.candidateId, operator);
          diff = { replayed: p };
          break;
        }
        case "DEVIATE": {
          const p = v.payload as { skipStage: MissionStage };
          await m.deviate(p.skipStage, operator, rationale ?? "");
          diff = { skipped: p.skipStage };
          break;
        }
      }

      await repos.logIntervention({
        id: auditId,
        runId: args.runId,
        tenantId: m.run.tenantId,
        intent: args.intent,
        payload: args.payload,
        rationale: rationale,
        operator: args.operator,
        accepted: true,
        diff,
        at: Date.now(),
      });
      await repos.appendAudit({
        id: randomUUID(),
        runId: args.runId,
        tenantId: m.run.tenantId,
        type: "INTERVENTION",
        detail: { intent: args.intent, diff },
        operator: args.operator,
        at: Date.now(),
      });
      return { accepted: true, requiresConfirmation: false, diff, auditId };
    },
  },
  Subscription: {
    runEvents: {
      subscribe: (_: unknown, { runId }: { runId?: string }) => makeRunEventStream(runId),
      resolve: (e: unknown) => e,
    },
  },
};

function toStatus(m: ReturnType<typeof getLiveMission> & object) {
  const s = m!.status();
  return {
    runId: m!.run.id,
    stage: s.stage,
    status: s.status,
    costUsd: s.costUsd,
    etaSec: s.etaSec,
    goal: m!.run.goal,
    pendingGates: listPendingGates(m!.run.id).map((g) => ({ runId: g.runId, gate: g.gate, expiresAt: g.expiresAt })),
  };
}

async function idFromName(m: ReturnType<typeof getLiveMission> & object, name: string): Promise<string | null> {
  // Candidate names map (for the "reject Krithika" UX from §3.1). The orchestrator
  // doesn't keep names — we read from fixtures/resumes/resumes.json which is the
  // operator's source of truth at run-launch time.
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const arr = JSON.parse(readFileSync(resolve(process.cwd(), "fixtures/resumes/resumes.json"), "utf8"));
    const found = (arr as Array<{ id: string; name: string }>).find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    return found?.id ?? null;
  } catch {
    return null;
  }
}

async function* makeRunEventStream(runId?: string): AsyncGenerator<unknown> {
  const queue: unknown[] = [];
  let resolveNext: (() => void) | null = null;
  const off = bus.onRun((e) => {
    if (runId && e.runId !== runId) return;
    queue.push(e);
    resolveNext?.();
    resolveNext = null;
  });
  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((r) => (resolveNext = r));
    }
  } finally {
    off();
  }
}
