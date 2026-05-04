// Scoring helpers. R1 = profile-only, R2 = profile + phone, R3 = composite + interview.
// Uses the LLM via shared/llm.ts so the mock path is fully deterministic.

import type { MaskedProfile, Score, ScoreRound } from "@smaya/shared/schemas";
import type { VoiceCallOutput } from "@smaya/mcp-tools/voice-call";
import type { AvatarInterviewOutput } from "@smaya/mcp-tools/avatar-interview";
import { makeLLM } from "@smaya/shared/llm";

const llm = makeLLM();

interface R1Args { profile: MaskedProfile; jdId: string; }
interface R2Args { profile: MaskedProfile; r1: Score; phone: Extract<VoiceCallOutput, { status: "COMPLETED" }>; jdId: string; }
interface R3Args { profile: MaskedProfile; r2: Score; avatar: AvatarInterviewOutput; jdId: string; }

export async function scoreR1(args: R1Args): Promise<Score> {
  const prompt = `JD=${args.jdId}\nProfile: ${args.profile.summary}\nSkills: ${args.profile.skills.join(",")}\nYears: ${args.profile.yearsTotal}`;
  const r = await llm.complete({ system: "SCORE_TASK_R1", prompt, stableKey: `R1:${args.profile.id}` });
  const parsed = JSON.parse(r.text) as { composite: number; dimensions: Record<string, number>; rationale: string };
  return {
    candidateId: args.profile.id,
    round: "R1",
    composite: parsed.composite,
    dimensions: parsed.dimensions,
    rationale: parsed.rationale,
  };
}

export async function scoreR2(args: R2Args): Promise<Score> {
  const prompt = `JD=${args.jdId}\nProfile: ${args.profile.summary}\nR1: ${args.r1.composite}\nPhone screen score: ${args.phone.screenScore}\nSentiment: ${args.phone.sentiment}`;
  const r = await llm.complete({ system: "SCORE_TASK_R2", prompt, stableKey: `R2:${args.profile.id}` });
  const parsed = JSON.parse(r.text) as { composite: number; dimensions: Record<string, number>; rationale: string };
  // Blend phone signal: 70% LLM, 30% phone screen.
  const blended = Math.round(0.7 * parsed.composite + 0.3 * args.phone.screenScore);
  return {
    candidateId: args.profile.id,
    round: "R2",
    composite: blended,
    dimensions: { ...parsed.dimensions, phone_screen: args.phone.screenScore },
    rationale: `${parsed.rationale} Phone signal: ${args.phone.screenScore}/100, sentiment ${args.phone.sentiment.toFixed(2)}.`,
  };
}

export async function scoreR3(args: R3Args): Promise<Score> {
  const sig = args.avatar.signal;
  const interviewAvg = (sig.technicalDepth + sig.communication + sig.problemSolving + sig.cultureFit) / 4;
  const prompt = `JD=${args.jdId}\nR2: ${args.r2.composite}\nInterview avg: ${interviewAvg}\nRed flags: ${args.avatar.redFlags.join(",") || "none"}\nGreen flags: ${args.avatar.greenFlags.join(",") || "none"}`;
  const r = await llm.complete({ system: "SCORE_TASK_R3", prompt, stableKey: `R3:${args.profile.id}` });
  const parsed = JSON.parse(r.text) as { composite: number; dimensions: Record<string, number>; rationale: string };
  // Composite: 60% LLM, 40% interview signal.
  const blended = Math.round(0.6 * parsed.composite + 0.4 * interviewAvg);
  return {
    candidateId: args.profile.id,
    round: "R3",
    composite: blended,
    dimensions: { ...parsed.dimensions, interview_avg: interviewAvg, ...sig },
    rationale: `${parsed.rationale} Interview avg: ${interviewAvg.toFixed(1)}/100. Flags: red=${args.avatar.redFlags.length}, green=${args.avatar.greenFlags.length}.`,
  };
}

export function rankLeaderboard(r3Scores: Score[], topN: number): Array<{ candidateId: string; composite: number; rationale: string; rank: number }> {
  return [...r3Scores]
    .sort((a, b) => b.composite - a.composite)
    .map((s, i) => ({ candidateId: s.candidateId, composite: s.composite, rationale: s.rationale, rank: i + 1 }))
    .filter((r) => r.rank <= topN);
}

export function rankLeaderboardAll(r3Scores: Score[]): Array<{ candidateId: string; composite: number; rationale: string; rank: number }> {
  return [...r3Scores]
    .sort((a, b) => b.composite - a.composite)
    .map((s, i) => ({ candidateId: s.candidateId, composite: s.composite, rationale: s.rationale, rank: i + 1 }));
}

export type { ScoreRound };
