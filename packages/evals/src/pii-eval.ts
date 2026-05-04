// PII-masking eval. Pre-side-effect to: Cosmos write of parsed resume.
// Threshold: 100% mask rate on golden 5.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { tokenize, generalizeLocation } from "@smaya/shared/pii";
import { maskProfile, extractFromText } from "@smaya/mcp-tools/resume-parser";
import type { BehaviorEval } from "./harness.js";

const Golden = z.array(z.object({
  id: z.string(),
  rawText: z.string(),
  expectedMaskedFields: z.object({
    nameToken: z.string(),
    emailToken: z.string(),
    phoneToken: z.string(),
    locationGeneralized: z.string(),
  }),
}));

interface PiiEvalInput {
  candidates: Array<{ id: string; rawText: string }>;
}

export const piiEval: BehaviorEval<PiiEvalInput> = {
  name: "PII_MASKING",
  threshold: 1.0,
  async run(_ctx, input) {
    const goldenPath = resolve(process.cwd(), "fixtures/golden/pii-golden.json");
    const golden = Golden.parse(JSON.parse(readFileSync(goldenPath, "utf8")));

    let pass = 0;
    const failures: Array<{ id: string; field: string; expected: string; got: string }> = [];

    for (const g of golden) {
      const raw = extractFromText(g.rawText, g.id);
      const masked = maskProfile(raw);
      const checks: Array<[string, string, string]> = [
        ["nameToken", g.expectedMaskedFields.nameToken, masked.nameToken],
        ["emailToken", g.expectedMaskedFields.emailToken, masked.emailToken],
        ["phoneToken", g.expectedMaskedFields.phoneToken, masked.phoneToken],
        ["locationGeneralized", g.expectedMaskedFields.locationGeneralized, masked.locationGeneralized],
      ];
      const failedHere = checks.filter(([, exp, got]) => exp !== got);
      if (failedHere.length === 0) pass++;
      else failedHere.forEach(([field, exp, got]) => failures.push({ id: g.id, field, expected: exp, got }));
    }

    const score = pass / golden.length;
    return {
      passed: score >= 1.0,
      score,
      threshold: 1.0,
      details: { evaluated: golden.length, passed: pass, failures, candidatesInRun: input.candidates.length },
    };
  },
};

export { tokenize, generalizeLocation };
