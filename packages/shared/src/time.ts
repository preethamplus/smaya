// Compressed time: wall-clock is real, but mission semantics (heartbeats, gate timeouts)
// can be compressed by a factor for testing. SMAYA_COMPRESS_FACTOR=60 ⇒ 1 simulated minute = 1 real second.
//
// Drift measurement always uses real wall-clock so cadence correctness is genuine.

let factor = Number(process.env.SMAYA_COMPRESS_FACTOR ?? "1");
if (!Number.isFinite(factor) || factor <= 0) factor = 1;

export function setCompressFactor(f: number): void {
  factor = f;
}

export function compressFactor(): number {
  return factor;
}

/** Convert simulated milliseconds to real wall-clock milliseconds. */
export function simToReal(simMs: number): number {
  return Math.max(1, Math.round(simMs / factor));
}

/** Convert real wall-clock milliseconds to simulated milliseconds. */
export function realToSim(realMs: number): number {
  return Math.round(realMs * factor);
}

export function now(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
