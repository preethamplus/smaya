// Stateful heartbeat. NOT a cron job:
//   - Persists `nextTickAt` to Cosmos (via repos.putRun on every tick).
//   - Measures wall-clock drift and emits to the trace.
//   - Detects skips (now − lastTickAt > 2.5 × cadence) and emits an alert event.
//   - Adaptive cadence: faster while waiting on PHONE_SCREEN/AVATAR completion,
//     slower while waiting on a human gate.
//   - Resume-safe: if the orchestrator restarts mid-tick, the next tick is reconciled
//     from the persisted nextTickAt — not memory.

import type { RunRecord } from "@smaya/shared/schemas";
import { tracer } from "@smaya/shared/telemetry";
import { compressFactor, simToReal } from "@smaya/shared/time";
import { repos } from "@smaya/data";
import { bus } from "./bus.js";

export const ACTIVE_CADENCE_SIM_MS = 60 * 1000;
export const PASSIVE_CADENCE_SIM_MS = 5 * 60 * 1000;
const DRIFT_ALERT_MS = 30 * 1000;
const SKIP_FACTOR = 2.5;

export function chooseCadence(stage: RunRecord["stage"]): number {
  // Faster while we have outstanding async MCP work; slower while waiting on humans.
  switch (stage) {
    case "PHONE_SCREEN":
    case "NUDGE":
    case "AVATAR":
    case "INGEST":
    case "PARSE":
    case "SCORE_R1":
    case "SCORE_R2":
    case "SCORE_R3":
    case "SEND_LEADERBOARD":
    case "SCHEDULE_PANEL":
    case "DECISION_PACK":
    case "SELF_PAUSE":
      return ACTIVE_CADENCE_SIM_MS;
    case "GATE_1":
    case "GATE_2":
      return PASSIVE_CADENCE_SIM_MS;
  }
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private skipCount = 0;
  private lastTickAt = 0;

  constructor(
    private run: RunRecord,
    private onTick: () => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.lastTickAt = Date.now();
    await this.persistTickPlan();
    this.schedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Externally driven for testing — kicks one tick now. */
  async forceTick(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.tick();
    this.schedule();
  }

  private schedule(): void {
    const cadenceSim = chooseCadence(this.run.stage);
    const realDelay = simToReal(cadenceSim);
    this.timer = setTimeout(() => {
      this.tick().then(() => this.schedule()).catch((err) => {
        tracer.event("heartbeat.error", { message: String(err) });
        this.schedule();
      });
    }, realDelay);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const expectedRealMs = simToReal(chooseCadence(this.run.stage));
    const driftMs = now - this.run.heartbeat.nextTickAt;
    if (driftMs > DRIFT_ALERT_MS) {
      tracer.event("heartbeat.drift_alert", { driftMs });
      bus.emitRun({
        type: "HEARTBEAT",
        runId: this.run.id,
        tenantId: this.run.tenantId,
        detail: { driftMs, alert: true },
        at: now,
      });
    }
    if (this.lastTickAt && now - this.lastTickAt > expectedRealMs * SKIP_FACTOR) {
      this.skipCount++;
      tracer.event("heartbeat.skip", { skipCount: this.skipCount });
    }
    this.lastTickAt = now;
    this.run.heartbeat = {
      lastTickAt: now,
      nextTickAt: now + expectedRealMs,
      cadenceMs: chooseCadence(this.run.stage),
      driftMs,
      skipCount: this.skipCount,
    };
    await this.persistTickPlan();
    bus.emitRun({
      type: "HEARTBEAT",
      runId: this.run.id,
      tenantId: this.run.tenantId,
      detail: { driftMs, cadenceMs: this.run.heartbeat.cadenceMs, skipCount: this.skipCount, compress: compressFactor() },
      at: now,
    });
    await this.onTick();
  }

  private async persistTickPlan(): Promise<void> {
    this.run.updatedAt = Date.now();
    await repos.putRun(this.run);
  }
}
