// Eval harness contract: every behavior eval must implement this shape.
// The orchestrator calls run(...) BEFORE the corresponding side effect, and
// only proceeds if passed === true.
//
// Why this matters: §5.2 calls out "Running evals after the side effect has fired"
// as auto-reject. The harness is the single chokepoint that makes that mistake
// impossible — every gate the orchestrator places is `if (!evalRes.passed) pause()`.

import type { EvalResult } from "@smaya/shared/schemas";

export interface EvalContext {
  runId: string;
  tenantId: string;
}

export interface EvalReport {
  passed: boolean;
  score: number;
  threshold: number;
  details: unknown;
}

export interface BehaviorEval<I> {
  name: EvalResult["evalName"];
  /** Threshold below which the eval blocks the side effect. Comparison is `>=`. */
  threshold: number;
  run(ctx: EvalContext, input: I): Promise<EvalReport>;
}
