import React, { useEffect, useRef, useState } from "react";
import { gql } from "../api.js";

interface Run { runId: string; stage: string; status: string; }

interface ChatMsg {
  who: "user" | "agent";
  text: string;
  intent?: string;
  diff?: unknown;
  refused?: boolean;
  reason?: string;
  pendingConfirm?: { intent: string; payload: unknown; rationale?: string };
  meta?: string;
}

export function AgentTab(props: { run: Run }): React.ReactElement {
  const [log, setLog] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [operator, setOperator] = useState("recruiter@smaya.example.com");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const send = async (utterance: string, opts: { confirmed?: boolean; intent?: string; payload?: unknown; rationale?: string } = {}): Promise<void> => {
    setLog((l) => [...l, { who: "user", text: utterance }]);

    const intentInfo = opts.intent
      ? { intent: opts.intent, payload: opts.payload ?? {}, rationale: opts.rationale }
      : classifyClient(utterance);

    try {
      const res = await gql<{
        interveneRun: { accepted: boolean; requiresConfirmation: boolean; diff: unknown; reason?: string; auditId: string };
      }>(
        `mutation I(
          $id: ID!, $intent: InterventionIntent!, $payload: JSON!,
          $rationale: String, $operator: String!, $confirmed: Boolean
        ) {
          interveneRun(runId: $id, intent: $intent, payload: $payload, rationale: $rationale, operator: $operator, confirmed: $confirmed) {
            accepted requiresConfirmation diff reason auditId
          }
        }`,
        {
          id: props.run.runId,
          intent: intentInfo.intent,
          payload: intentInfo.payload,
          rationale: intentInfo.rationale ?? null,
          operator,
          confirmed: opts.confirmed ?? false,
        },
      );

      const r = res.interveneRun;
      if (r.requiresConfirmation && !r.accepted) {
        setLog((l) => [...l, {
          who: "agent",
          text: `Confirmation required for intent ${intentInfo.intent}.`,
          intent: intentInfo.intent,
          diff: r.diff,
          pendingConfirm: { intent: intentInfo.intent, payload: intentInfo.payload, rationale: intentInfo.rationale },
          meta: `audit ${r.auditId.slice(0, 8)}`,
        }]);
        return;
      }
      if (!r.accepted) {
        setLog((l) => [...l, {
          who: "agent",
          text: r.reason ?? "Refused.",
          intent: intentInfo.intent,
          refused: true,
          meta: `audit ${r.auditId.slice(0, 8)}`,
        }]);
        return;
      }
      setLog((l) => [...l, {
        who: "agent",
        text: `Accepted (${intentInfo.intent}).`,
        intent: intentInfo.intent,
        diff: r.diff,
        meta: `audit ${r.auditId.slice(0, 8)}`,
      }]);
    } catch (err) {
      setLog((l) => [...l, { who: "agent", text: `Error: ${(err as Error).message}`, refused: true }]);
    }
  };

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!input.trim()) return;
    void send(input.trim());
    setInput("");
  };

  return (
    <div>
      <div className="card">
        <h3>Operator</h3>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} style={{ width: 360, padding: 6 }} />
      </div>
      <div className="card">
        <h3>Agent chat — mid-flight intervention</h3>
        <div className="chat">
          <div className="chat-log" ref={logRef}>
            {log.map((m, i) => (
              <div key={i} className={`chat-row ${m.who}${m.refused ? " refused" : ""}`}>
                <div>{m.text}</div>
                {m.intent && <div className="meta">intent: {m.intent}</div>}
                {m.diff != null && <pre className="diff">{JSON.stringify(m.diff, null, 2)}</pre>}
                {m.pendingConfirm && (
                  <div className="confirm">
                    <button className="btn primary" onClick={() => void send("(confirmed)", { confirmed: true, ...m.pendingConfirm })}>Confirm</button>
                    <button className="btn" onClick={() => setLog((l) => l.map((x, idx) => (idx === i ? { ...x, pendingConfirm: undefined } : x)))}>Cancel</button>
                  </div>
                )}
                {m.meta && <div className="meta">{m.meta}</div>}
              </div>
            ))}
            {log.length === 0 && <div className="empty">Try: "where are you on candidate 4?", "top 5 instead of top 3", "skip Gate 1, dial out now", "reject Krithika even though she's top-3"</div>}
          </div>
          <form className="chat-form" onSubmit={onSubmit}>
            <input value={input} placeholder="say something to the agent…" onChange={(e) => setInput(e.target.value)} />
            <button type="submit" className="btn primary">Send</button>
          </form>
        </div>
      </div>
    </div>
  );
}

// Client-side intent classifier — same regex set as server-side, lets the UI label
// the intent before sending. (Server is the source of truth; this is purely UX.)
function classifyClient(utterance: string): { intent: string; payload: Record<string, unknown>; rationale?: string } {
  if (/\b(skip\s+gate\s+1|dial\s+out\s+now|approve\s+early|skip\s+gate\s*\d+|bypass\s+gate)\b/i.test(utterance)) {
    return { intent: "OVERRIDE_DECISION", payload: { kind: "skip_gate", target: "GATE_1" } };
  }
  const topN = utterance.match(/\btop\s*(\d+)\b/i);
  if (topN) return { intent: "UPDATE_GOAL", payload: { topN: parseInt(topN[1] ?? "3", 10) } };
  if (/\b(stop|abort|kill|cancel)\b/i.test(utterance)) return { intent: "STOP", payload: { reason: utterance } };
  if (/\bpause\b/i.test(utterance)) return { intent: "PAUSE", payload: {} };
  if (/\bresume|continue\b/i.test(utterance)) return { intent: "RESUME", payload: {} };
  const reject = utterance.match(/\breject\s+([A-Za-z][A-Za-z\s]*?)(?:\s+even|$|\s+anyway|\s+from)/i);
  if (reject) return { intent: "OVERRIDE_DECISION", payload: { kind: "reject_candidate", target: (reject[1] ?? "").trim() }, rationale: utterance };
  const skipStage = utterance.match(/\bskip\s+(?:the\s+)?(avatar|phone\s+screen|nudge)\b/i);
  if (skipStage) return { intent: "DEVIATE", payload: { skipStage: ((skipStage[1] ?? "").toUpperCase().includes("PHONE") ? "PHONE_SCREEN" : (skipStage[1] ?? "").toUpperCase().replace(/\s+/g, "_")) }, rationale: utterance };
  const replay = utterance.match(/\bre-?run\s+(score|parse)\s+for\s+candidate\s+(\d+)\b/i);
  if (replay) return { intent: "REPLAY_ACTION", payload: { kind: replay[1], candidateId: `c${(replay[2] ?? "0").padStart(2, "0")}` } };
  const ctx = utterance.match(/\b(also consider|take into account|include|factor in)\s+(.+)/i);
  if (ctx) return { intent: "ADD_CONTEXT", payload: { context: (ctx[2] ?? "").trim() } };
  return { intent: "STATUS_QUERY", payload: { raw: utterance } };
}
