// The 9 Cosmos containers required by the spec (§7 Module C).
// All partitioned by /tenantId. Container names are stable strings
// that the orchestrator and intervention API both import.

export const CONTAINERS = {
  agentRuns: "agentRuns",
  decisionPacks: "decisionPacks",
  auditLog: "auditLog",
  mcpCallLog: "mcpCallLog",
  costLedger: "costLedger",
  evalResults: "evalResults",
  candidates: "candidates",
  goalVersions: "goalVersions",
  interventions: "interventions",
} as const;

export type ContainerName = keyof typeof CONTAINERS;

export const PARTITION_KEY = "/tenantId";
