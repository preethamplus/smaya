// MCP tool: avatar-interview
// Local stub: returns deterministic interview signal.
// Spec §2.2 row 8.

import { z } from "zod";
import { defineTool } from "./wrap.js";
import { createHash } from "node:crypto";

const Input = z.object({
  candidateId: z.string().regex(/^c\d{2,}$/),
  jdId: z.string(),
  topics: z.array(z.string()).default([]),
});

const Output = z.object({
  candidateId: z.string(),
  durationSec: z.number().int().positive(),
  signal: z.object({
    technicalDepth: z.number().min(0).max(100),
    communication: z.number().min(0).max(100),
    problemSolving: z.number().min(0).max(100),
    cultureFit: z.number().min(0).max(100),
  }),
  redFlags: z.array(z.string()),
  greenFlags: z.array(z.string()),
});

export type AvatarInterviewInput = z.infer<typeof Input>;
export type AvatarInterviewOutput = z.infer<typeof Output>;

export const avatarInterview = defineTool({
  name: "avatar-interview",
  scope: "interview:run",
  inputSchema: Input,
  outputSchema: Output,
  handler: async (input) => {
    const seed = createHash("sha256").update(`avatar:${input.candidateId}`).digest("hex");
    const td = 40 + (parseInt(seed.slice(0, 4), 16) % 60);
    const co = 40 + (parseInt(seed.slice(4, 8), 16) % 60);
    const ps = 40 + (parseInt(seed.slice(8, 12), 16) % 60);
    const cf = 40 + (parseInt(seed.slice(12, 16), 16) % 60);

    const redFlags: string[] = [];
    const greenFlags: string[] = [];
    if (td < 55) redFlags.push("shallow_technical_answers");
    if (td > 80) greenFlags.push("strong_systems_thinking");
    if (co > 80) greenFlags.push("clear_communicator");
    if (ps < 55) redFlags.push("struggled_with_open_ended_design");

    return {
      candidateId: input.candidateId,
      durationSec: 1500 + (parseInt(seed.slice(16, 20), 16) % 600),
      signal: { technicalDepth: td, communication: co, problemSolving: ps, cultureFit: cf },
      redFlags,
      greenFlags,
    };
  },
});
