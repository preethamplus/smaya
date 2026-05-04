// Standalone runner — exercises each eval once against the golden datasets.
// Lets a reviewer verify evals work even with the orchestrator off.
import { piiEval } from "./pii-eval.js";
import { biasEval } from "./bias-eval.js";

const ctx = { runId: "standalone", tenantId: "default" };

console.log("== PII_MASKING ==");
const p = await piiEval.run(ctx, { candidates: [] });
console.log(JSON.stringify(p, null, 2));

console.log("== LEADERBOARD_BIAS ==");
const b = await biasEval.run(ctx, {
  leaderboard: [
    { candidateId: "c01", rank: 1 },
    { candidateId: "c04", rank: 2 },
    { candidateId: "c10", rank: 3 },
    { candidateId: "c02", rank: 4 },
    { candidateId: "c08", rank: 5 },
  ],
  topN: 3,
});
console.log(JSON.stringify(b, null, 2));
