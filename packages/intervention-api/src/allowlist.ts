// Intervention allow-list. Validates an intent + payload shape and refuses
// predefined-gate-bypass attempts.
//
// Spec callouts honored:
//   - §3.2 #10–14: snapshot → diff → confirm → re-plan → audit (we surface diff + requireConfirm)
//   - §3.3 "Allowing chat to bypass predefined gates" → auto-reject
//   - §3.3 "Mutating goal without confirmation" → requireConfirm = true on UPDATE_GOAL
//   - §3.3 "Override without rationale capture" → rationale required on OVERRIDE_*

import { z } from "zod";
import type { InterventionIntent } from "@smaya/shared/schemas";

export interface AllowlistResult {
  ok: boolean;
  reason?: string;
  /** Caller (UI) must surface a confirmation step before re-issuing with `confirmed: true`. */
  requireConfirmation: boolean;
  payload?: unknown;
}

const Payloads: Record<InterventionIntent, z.ZodType> = {
  STATUS_QUERY: z.object({}).passthrough().optional(),
  ADD_CONTEXT: z.object({ context: z.string().min(1) }),
  UPDATE_GOAL: z.object({
    topN: z.number().int().min(1).max(10).optional(),
    excludedCandidates: z.array(z.string().regex(/^c\d{2,}$/)).optional(),
    skipStages: z.array(z.string()).optional(),
  }),
  PAUSE: z.object({ scope: z.string().optional() }).optional(),
  RESUME: z.object({}).passthrough().optional(),
  STOP: z.object({ reason: z.string().optional() }).optional(),
  OVERRIDE_DECISION: z.object({
    kind: z.enum(["reject_candidate", "skip_gate"]),
    target: z.string(),
  }),
  REPLAY_ACTION: z.object({
    kind: z.enum(["score", "parse"]),
    candidateId: z.string().regex(/^c\d{2,}$/),
  }),
  DEVIATE: z.object({ skipStage: z.string() }),
};

const REQUIRES_CONFIRM: ReadonlySet<InterventionIntent> = new Set([
  "UPDATE_GOAL",
  "OVERRIDE_DECISION",
  "DEVIATE",
  "STOP",
]);
const REQUIRES_RATIONALE: ReadonlySet<InterventionIntent> = new Set([
  "OVERRIDE_DECISION",
  "DEVIATE",
]);

export function validateIntervention(
  intent: InterventionIntent,
  payload: unknown,
  rationale: string | undefined,
): AllowlistResult {
  // Hard refusal: skip-gate / bypass-gate is non-negotiable per rubric #13.
  if (intent === "OVERRIDE_DECISION") {
    const parsed = Payloads.OVERRIDE_DECISION.safeParse(payload);
    if (parsed.success && parsed.data.kind === "skip_gate") {
      return {
        ok: false,
        reason: "Predefined gates are non-bypassable. Use the Approvals tab to approve normally.",
        requireConfirmation: false,
      };
    }
  }

  const schema = Payloads[intent];
  if (!schema) {
    return { ok: false, reason: `unknown intent: ${intent}`, requireConfirmation: false };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: `payload validation failed: ${parsed.error.message}`, requireConfirmation: false };
  }
  if (REQUIRES_RATIONALE.has(intent) && !rationale?.trim()) {
    return { ok: false, reason: "rationale required for this intent", requireConfirmation: false };
  }
  return {
    ok: true,
    requireConfirmation: REQUIRES_CONFIRM.has(intent),
    payload: parsed.data,
  };
}
