// All cross-module schemas. Zod is the source of truth — TypeScript types are inferred.
// Anything that crosses an MCP boundary or a Cosmos boundary must be validated through here.
import { z } from "zod";

// ---- Tenant + identity ----------------------------------------------------

export const TenantId = z.string().regex(/^[a-z0-9-]{3,64}$/);
export type TenantId = z.infer<typeof TenantId>;

export const RunId = z.string().min(1);
export type RunId = z.infer<typeof RunId>;

export const CandidateId = z.string().regex(/^c\d{2,}$/);
export type CandidateId = z.infer<typeof CandidateId>;

// ---- Mission stages -------------------------------------------------------

export const MissionStage = z.enum([
  "INGEST",
  "PARSE",
  "SCORE_R1",
  "GATE_1",
  "PHONE_SCREEN",
  "NUDGE",
  "SCORE_R2",
  "AVATAR",
  "SCORE_R3",
  "SEND_LEADERBOARD",
  "GATE_2",
  "SCHEDULE_PANEL",
  "DECISION_PACK",
  "SELF_PAUSE",
]);
export type MissionStage = z.infer<typeof MissionStage>;

export const RunStatus = z.enum([
  "RUNNING",
  "PAUSED",
  "STOPPED",
  "AWAITING_GATE",
  "COMPLETED",
  "FAILED",
]);
export type RunStatus = z.infer<typeof RunStatus>;

// ---- Resume / candidate ---------------------------------------------------

const Experience = z.object({
  role: z.string(),
  company: z.string(),
  years: z.string(),
  highlights: z.array(z.string()),
});

const Education = z.object({
  degree: z.string(),
  school: z.string(),
  year: z.number().int(),
});

// Raw parsed structure (PII still present). NEVER persisted directly.
export const ParsedResumeRaw = z.object({
  id: CandidateId,
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  location: z.string(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  summary: z.string(),
  skills: z.array(z.string()),
  experience: z.array(Experience),
  education: z.array(Education),
});
export type ParsedResumeRaw = z.infer<typeof ParsedResumeRaw>;

// PII-masked profile. THIS is what we persist.
export const MaskedProfile = z.object({
  id: CandidateId,
  nameToken: z.string().regex(/^\[NAME:[A-F0-9]{8}\]$/),
  emailToken: z.string().regex(/^\[EMAIL:[A-F0-9]{8}\]$/),
  phoneToken: z.string().regex(/^\[PHONE:[A-F0-9]{8}\]$/),
  locationGeneralized: z.string(),
  hasLinkedIn: z.boolean(),
  hasGitHub: z.boolean(),
  yearsTotal: z.number().min(0).max(60),
  summary: z.string(),
  skills: z.array(z.string()),
  experience: z.array(Experience),
  education: z.array(Education),
});
export type MaskedProfile = z.infer<typeof MaskedProfile>;

// ---- Scoring --------------------------------------------------------------

export const ScoreRound = z.enum(["R1", "R2", "R3"]);
export type ScoreRound = z.infer<typeof ScoreRound>;

export const Score = z.object({
  candidateId: CandidateId,
  round: ScoreRound,
  composite: z.number().min(0).max(100),
  dimensions: z.record(z.string(), z.number().min(0).max(100)),
  rationale: z.string(),
});
export type Score = z.infer<typeof Score>;

// ---- Mission state --------------------------------------------------------

export const MissionGoal = z.object({
  topN: z.number().int().min(1).max(10),
  jdId: z.string(),
  excludedCandidates: z.array(CandidateId).default([]),
  skipStages: z.array(MissionStage).default([]),
});
export type MissionGoal = z.infer<typeof MissionGoal>;

export const Heartbeat = z.object({
  lastTickAt: z.number(),
  nextTickAt: z.number(),
  cadenceMs: z.number().int().positive(),
  driftMs: z.number().int(),
  skipCount: z.number().int().min(0),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const RunRecord = z.object({
  id: RunId,
  tenantId: TenantId,
  goal: MissionGoal,
  goalVersion: z.number().int().min(1),
  status: RunStatus,
  stage: MissionStage,
  candidateIds: z.array(CandidateId),
  heartbeat: Heartbeat,
  costUsd: z.number().min(0),
  costCapUsd: z.number().min(0),
  startedAt: z.number(),
  updatedAt: z.number(),
  pausedReason: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;

// ---- MCP -----------------------------------------------------------------

export const McpInvocation = z.object({
  id: z.string(),
  runId: RunId,
  tenantId: TenantId,
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  costUsd: z.number().min(0).default(0),
  idempotencyKey: z.string(),
  gateClearance: z.boolean(),
});
export type McpInvocation = z.infer<typeof McpInvocation>;

// ---- Audit + intervention ------------------------------------------------

export const InterventionIntent = z.enum([
  "STATUS_QUERY",
  "ADD_CONTEXT",
  "UPDATE_GOAL",
  "PAUSE",
  "RESUME",
  "STOP",
  "OVERRIDE_DECISION",
  "REPLAY_ACTION",
  "DEVIATE",
]);
export type InterventionIntent = z.infer<typeof InterventionIntent>;

export const InterventionRecord = z.object({
  id: z.string(),
  runId: RunId,
  tenantId: TenantId,
  intent: InterventionIntent,
  payload: z.unknown(),
  rationale: z.string().optional(),
  operator: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  diff: z.unknown().optional(),
  at: z.number(),
});
export type InterventionRecord = z.infer<typeof InterventionRecord>;

export const AuditEntry = z.object({
  id: z.string(),
  runId: RunId,
  tenantId: TenantId,
  type: z.enum([
    "STAGE_TRANSITION",
    "GATE_REQUESTED",
    "GATE_APPROVED",
    "GATE_REJECTED",
    "INTERVENTION",
    "MCP_CALL",
    "EVAL_RESULT",
    "BUDGET_PAUSE",
    "ERROR",
  ]),
  detail: z.unknown(),
  operator: z.string().optional(),
  at: z.number(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---- Decision Pack -------------------------------------------------------

export const DecisionPack = z.object({
  runId: RunId,
  tenantId: TenantId,
  jdId: z.string(),
  topN: z.number().int().positive(),
  leaderboard: z.array(
    z.object({
      candidateId: CandidateId,
      composite: z.number(),
      rationale: z.string(),
      rank: z.number().int().min(1),
    })
  ),
  panelSlot: z.object({
    candidateId: CandidateId,
    startsAt: z.number(),
    endsAt: z.number(),
    panelMembers: z.array(z.string()),
  }).optional(),
  costUsd: z.number().min(0),
  durationMs: z.number().int().min(0),
  evalSummary: z.array(z.object({
    name: z.string(),
    score: z.number(),
    threshold: z.number(),
    passed: z.boolean(),
  })),
  interventionCount: z.number().int().min(0),
  status: z.enum(["COMPLETED", "ABORTED"]),
  generatedAt: z.number(),
});
export type DecisionPack = z.infer<typeof DecisionPack>;

// ---- Eval ----------------------------------------------------------------

export const EvalResult = z.object({
  id: z.string(),
  runId: RunId,
  tenantId: TenantId,
  evalName: z.enum(["PII_MASKING", "SCORE_STABILITY", "LEADERBOARD_BIAS"]),
  score: z.number(),
  threshold: z.number(),
  passed: z.boolean(),
  details: z.unknown(),
  at: z.number(),
});
export type EvalResult = z.infer<typeof EvalResult>;
