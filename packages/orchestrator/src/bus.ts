// In-process event bus for run-state changes. The UI subscribes via SSE
// (intervention-api wires it). Decoupled so the orchestrator doesn't import the API.

import { EventEmitter } from "node:events";

interface RunEvent {
  type:
    | "STAGE_TRANSITION"
    | "GATE_REQUESTED"
    | "GATE_APPROVED"
    | "INTERVENTION"
    | "MCP_CALL"
    | "EVAL_RESULT"
    | "HEARTBEAT"
    | "BUDGET_PAUSE"
    | "RUN_COMPLETED"
    | "RUN_ABORTED"
    | "RUN_PAUSED"
    | "RUN_RESUMED";
  runId: string;
  tenantId: string;
  detail: unknown;
  at: number;
}

class Bus extends EventEmitter {
  emitRun(e: RunEvent): void {
    this.emit("run", e);
  }
  onRun(listener: (e: RunEvent) => void): () => void {
    this.on("run", listener);
    return () => this.off("run", listener);
  }
}

export const bus = new Bus();
export type { RunEvent };
