// Per-mission simulated cost ledger. Auto-pause at 80% of cap.
// Costs are simulated — every MCP / LLM call posts to the ledger with a fixed unit cost.

export interface CostEntry {
  runId: string;
  source: string; // "llm.parse" | "mcp.voice-call" | ...
  usd: number;
  at: number;
}

export interface CostLedger {
  add(entry: CostEntry): void;
  total(runId: string): number;
  cap(runId: string): number;
  isAtBudgetCap(runId: string): boolean;
  isAtSoftCap(runId: string): boolean;
  setCap(runId: string, capUsd: number): void;
  entries(runId: string): CostEntry[];
}

const DEFAULT_CAP_USD = Number(process.env.SMAYA_BUDGET_USD ?? "5.0");
const SOFT_CAP_RATIO = 0.8;

export class InMemoryCostLedger implements CostLedger {
  private byRun: Map<string, CostEntry[]> = new Map();
  private capByRun: Map<string, number> = new Map();

  setCap(runId: string, capUsd: number): void {
    this.capByRun.set(runId, capUsd);
  }
  cap(runId: string): number {
    return this.capByRun.get(runId) ?? DEFAULT_CAP_USD;
  }
  add(entry: CostEntry): void {
    const arr = this.byRun.get(entry.runId) ?? [];
    arr.push(entry);
    this.byRun.set(entry.runId, arr);
  }
  total(runId: string): number {
    return (this.byRun.get(runId) ?? []).reduce((a, e) => a + e.usd, 0);
  }
  isAtBudgetCap(runId: string): boolean {
    return this.total(runId) >= this.cap(runId);
  }
  isAtSoftCap(runId: string): boolean {
    return this.total(runId) >= SOFT_CAP_RATIO * this.cap(runId);
  }
  entries(runId: string): CostEntry[] {
    return [...(this.byRun.get(runId) ?? [])];
  }
}

export const costLedger: CostLedger = new InMemoryCostLedger();
