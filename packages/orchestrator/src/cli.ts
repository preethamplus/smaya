// Standalone runner: starts mock servers, runs one mission to completion.
// Use:
//   tsx src/cli.ts --in-memory --compress 60
import { resolve } from "node:path";
import { setCompressFactor } from "@smaya/shared/time";
import { startMockSlack, startMockOutlook } from "@smaya/mcp-tools/mock-servers";
import { Mission, registerLiveMission } from "./mission.js";

const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i] ?? "";
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, true);
    }
  }
}

if (args.get("compress")) setCompressFactor(Number(args.get("compress")));

startMockSlack();
startMockOutlook();

const mission = new Mission({
  tenantId: "default",
  goal: { topN: 3, jdId: "smaya-senior-backend-2026", excludedCandidates: [], skipStages: [] },
  resumesDir: resolve(process.cwd(), "fixtures/resumes/pdf"),
  budgetUsd: 5.0,
});
registerLiveMission(mission);

console.log(`mission ${mission.run.id} starting…`);
await mission.run_();
console.log(`mission ${mission.run.id} status=${mission.run.status} stage=${mission.run.stage}`);
process.exit(0);
