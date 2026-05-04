// MCP tool: voice-call
// Local stub: returns deterministic transcript JSON.
// Spec §6 row 5: stubbed MCP tool. Idempotent.
//
// Behavior: NO_ANSWER for c03 and c09 on first attempt → triggers nudge logic.
// Otherwise returns a transcript with a "screen score" derived from candidateId.

import { z } from "zod";
import { defineTool } from "./wrap.js";
import { createHash } from "node:crypto";

const Input = z.object({
  candidateId: z.string().regex(/^c\d{2,}$/),
  attempt: z.number().int().min(1).max(3),
  jdId: z.string(),
});

const Output = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("NO_ANSWER"),
    candidateId: z.string(),
    attempt: z.number(),
    nextRetryHintMs: z.number(),
  }),
  z.object({
    status: z.literal("COMPLETED"),
    candidateId: z.string(),
    transcript: z.string(),
    durationSec: z.number().int().positive(),
    sentiment: z.number().min(-1).max(1),
    keyTopics: z.array(z.string()),
    screenScore: z.number().min(0).max(100),
  }),
]);

export type VoiceCallInput = z.infer<typeof Input>;
export type VoiceCallOutput = z.infer<typeof Output>;

const NO_ANSWER_FIRST_ATTEMPT = new Set(["c03", "c09"]);

export const voiceCall = defineTool({
  name: "voice-call",
  scope: "voice:call",
  inputSchema: Input,
  outputSchema: Output,
  handler: async (input) => {
    if (NO_ANSWER_FIRST_ATTEMPT.has(input.candidateId) && input.attempt === 1) {
      return {
        status: "NO_ANSWER",
        candidateId: input.candidateId,
        attempt: input.attempt,
        nextRetryHintMs: 500 * Math.pow(4, input.attempt - 1), // 500ms, 2s, 8s
      };
    }

    const seed = createHash("sha256").update(`voice:${input.candidateId}`).digest("hex");
    const screenScore = 50 + (parseInt(seed.slice(0, 4), 16) % 50);
    const sentiment = ((parseInt(seed.slice(4, 8), 16) % 200) - 100) / 100;
    const durationSec = 180 + (parseInt(seed.slice(8, 12), 16) % 240);
    const transcript = [
      `Recruiter: Hi, is this candidate ${input.candidateId}? Thanks for taking the call.`,
      `Candidate: Yes, happy to talk.`,
      `Recruiter: Walk me through your most recent work.`,
      `Candidate: ${candidateNarrative(input.candidateId)}`,
      `Recruiter: Great. We'll be in touch.`,
    ].join("\n");

    return {
      status: "COMPLETED",
      candidateId: input.candidateId,
      transcript,
      durationSec,
      sentiment,
      keyTopics: ["recent_role", "tech_stack", "interest_level"],
      screenScore,
    };
  },
});

function candidateNarrative(id: string): string {
  const map: Record<string, string> = {
    c01: "I have been leading a Temporal-based orchestration system for fulfillment.",
    c02: "I built a behavior eval harness with about 1.2k golden cases.",
    c03: "Currently owning restaurant onboarding at Zomato.",
    c04: "Most of my time goes to a Cadence cluster handling about 12M tasks per day.",
    c05: "I've been working on agentic retrieval at a YC company.",
    c06: "Lately mostly merchant dashboard and partner GraphQL surfaces.",
    c07: "Still primarily SRE, owning OTel adoption across services.",
    c08: "I built an MCP server for enterprise search.",
    c09: "Mostly Java microservices for a banking client at TCS, recently moved to Salesforce.",
    c10: "Tech-leading the support agent — I designed the mid-flight intervention layer.",
  };
  return map[id] ?? "I am happy to discuss further.";
}
