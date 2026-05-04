// Chat → intent classifier.
//
// REGEX-FIRST by design: §3.3 calls out "Treating chat as direct LLM prompt" as
// auto-reject. Only when no regex hits do we fall through to the LLM (and only
// if SMAYA_LLM != mock — in mock mode we return STATUS_QUERY by default).

import type { InterventionIntent } from "@smaya/shared/schemas";

interface Match {
  intent: InterventionIntent;
  payload: Record<string, unknown>;
  confidence: number;
}

const RULES: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Match }> = [
  // STATUS_QUERY
  {
    re: /\b(where are you|status|how (much|many)|what'?s the progress|eta)\b/i,
    build: () => ({ intent: "STATUS_QUERY", payload: {}, confidence: 0.95 }),
  },
  // ADD_CONTEXT
  {
    re: /\b(also consider|take into account|include|factor in)\s+(.+)/i,
    build: (m) => ({ intent: "ADD_CONTEXT", payload: { context: (m[2] ?? "").trim() }, confidence: 0.9 }),
  },
  // UPDATE_GOAL — top N
  {
    re: /\btop\s*(\d+)\b/i,
    build: (m) => ({ intent: "UPDATE_GOAL", payload: { topN: parseInt(m[1] ?? "3", 10) }, confidence: 0.95 }),
  },
  // PAUSE — be specific so we don't catch "pause for a sec" in noise
  {
    re: /\bpause(\s+the\s+(\w+))?\b/i,
    build: (m) => ({ intent: "PAUSE", payload: { scope: m[2] ?? "all" }, confidence: 0.9 }),
  },
  // RESUME
  {
    re: /\b(resume|continue|carry on)\b/i,
    build: () => ({ intent: "RESUME", payload: {}, confidence: 0.95 }),
  },
  // STOP / abort
  {
    re: /\b(stop|abort|kill|cancel)\s+(the\s+)?(mission|run|agent)?/i,
    build: () => ({ intent: "STOP", payload: {}, confidence: 0.95 }),
  },
  // OVERRIDE_DECISION — reject candidate
  {
    re: /\breject\s+([A-Za-z][A-Za-z\s]*?)(?:\s+even|$|\s+anyway|\s+from)/i,
    build: (m) => ({
      intent: "OVERRIDE_DECISION",
      payload: { kind: "reject_candidate", target: (m[1] ?? "").trim() },
      confidence: 0.9,
    }),
  },
  // OVERRIDE_DECISION — bypass gate (must be refused upstream)
  {
    re: /\b(skip|bypass)\s+gate\s*(\d+)\b/i,
    build: (m) => ({
      intent: "OVERRIDE_DECISION",
      payload: { kind: "skip_gate", target: `GATE_${m[2] ?? "?"}` },
      confidence: 0.95,
    }),
  },
  // OVERRIDE_DECISION — dial-out approval phrasing also routed here for refusal
  {
    re: /\b(skip\s+gate\s+1|dial\s+out\s+now|approve\s+early)\b/i,
    build: () => ({
      intent: "OVERRIDE_DECISION",
      payload: { kind: "skip_gate", target: "GATE_1" },
      confidence: 0.95,
    }),
  },
  // REPLAY_ACTION
  {
    re: /\bre-?run\s+(score|parse)\s+for\s+candidate\s+(\d+)\b/i,
    build: (m) => ({
      intent: "REPLAY_ACTION",
      payload: { kind: m[1] ?? "score", candidateId: `c${(m[2] ?? "0").padStart(2, "0")}` },
      confidence: 0.9,
    }),
  },
  // DEVIATE — skip a stage
  {
    re: /\bskip\s+(?:the\s+)?(avatar|phone\s+screen|nudge)\b/i,
    build: (m) => ({
      intent: "DEVIATE",
      payload: { skipStage: ((m[1] ?? "").toUpperCase().includes("PHONE") ? "PHONE_SCREEN" : (m[1] ?? "").toUpperCase().replace(/\s+/g, "_")) },
      confidence: 0.9,
    }),
  },
];

export function classifyIntent(utterance: string): Match {
  for (const rule of RULES) {
    const m = utterance.match(rule.re);
    if (m) return rule.build(m);
  }
  return { intent: "STATUS_QUERY", payload: { raw: utterance }, confidence: 0.3 };
}
