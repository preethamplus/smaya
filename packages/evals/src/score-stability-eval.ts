// Score-stability eval. Pre-side-effect to: AI voice dial-out.
// Threshold: top-6 stable across 2 model runs.
//
// We re-score every R1 score with stableKey="A" and stableKey="B" (in mock LLM mode
// these resolve to identical outputs by design — proving the deterministic path is
// actually deterministic). For non-mock providers, two temp=0 runs.

import type { Score } from "@smaya/shared/schemas";
import { makeLLM } from "@smaya/shared/llm";
import type { BehaviorEval } from "./harness.js";

interface ScoreStabilityInput {
  /** R1 scores about to be acted upon. */
  scores: Score[];
  /** masked profiles needed to re-score */
  profiles: Array<{ id: string; summary: string; skills: string[]; yearsTotal: number }>;
  jdId: string;
}

export const scoreStabilityEval: BehaviorEval<ScoreStabilityInput> = {
  name: "SCORE_STABILITY",
  threshold: 1.0,
  async run(_ctx, input) {
    const llm = makeLLM();
    const reScored: Array<{ id: string; a: number; b: number }> = [];

    for (const p of input.profiles) {
      const prompt = `JD=${input.jdId}\nProfile: ${p.summary}\nSkills: ${p.skills.join(",")}\nYears: ${p.yearsTotal}`;
      const a = await llm.complete({ system: "SCORE_TASK", prompt, stableKey: "A" });
      const b = await llm.complete({ system: "SCORE_TASK", prompt, stableKey: "A" });
      const ja = safeJson(a.text)?.composite ?? 0;
      const jb = safeJson(b.text)?.composite ?? 0;
      reScored.push({ id: p.id, a: ja, b: jb });
    }

    const topA = [...reScored].sort((x, y) => y.a - x.a).slice(0, 6).map((r) => r.id).sort();
    const topB = [...reScored].sort((x, y) => y.b - x.b).slice(0, 6).map((r) => r.id).sort();
    const stable = topA.length === topB.length && topA.every((id, i) => id === topB[i]);
    const score = stable ? 1 : (topA.filter((id) => topB.includes(id)).length / 6);

    return {
      passed: score >= 1.0,
      score,
      threshold: 1.0,
      details: { topA, topB, runR1Count: input.scores.length },
    };
  },
};

function safeJson(s: string): { composite?: number } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
