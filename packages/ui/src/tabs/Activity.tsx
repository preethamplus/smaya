import React, { useEffect, useState } from "react";
import { gql, type RunEvent } from "../api.js";

interface Run { runId: string; stage: string; status: string; costUsd: number; goal: unknown; }

interface SlackMsg { ts: string; channel: string; text: string; }
interface OutlookEv { id: string; kind: string; subject: string; description?: string; startsAt?: number; }

export function ActivityTab(props: { run: Run; events: RunEvent[] }): React.ReactElement {
  const [slack, setSlack] = useState<SlackMsg[]>([]);
  const [emails, setEmails] = useState<OutlookEv[]>([]);
  const [calendar, setCalendar] = useState<OutlookEv[]>([]);
  const [decisionPack, setDecisionPack] = useState<unknown>(null);

  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        const d = await gql<{ slackMessages: SlackMsg[]; outlookEmails: OutlookEv[]; outlookEvents: OutlookEv[]; decisionPack: unknown }>(
          `query Q($id: ID!) {
            slackMessages
            outlookEmails
            outlookEvents
            decisionPack(runId: $id)
          }`,
          { id: props.run.runId },
        );
        setSlack(d.slackMessages ?? []);
        setEmails(d.outlookEmails ?? []);
        setCalendar(d.outlookEvents ?? []);
        setDecisionPack(d.decisionPack ?? null);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [props.run.runId]);

  return (
    <div>
      <div className="card">
        <div className="h">
          <strong>{props.run.runId.slice(0, 8)}</strong>
          <span className="kv"><b>stage</b>{props.run.stage}</span>
          <span className="kv"><b>status</b>{props.run.status}</span>
          <span className="kv"><b>cost</b>${props.run.costUsd.toFixed(3)}</span>
        </div>
      </div>

      <div className="card">
        <h3>Timeline</h3>
        <div className="timeline">
          {props.events.map((e, i) => (
            <div key={i} className={`event ${e.type}`}>
              <div className="ts">{new Date(e.at).toISOString().slice(11, 23)}</div>
              <div className="type">{e.type}</div>
              <div>{summary(e)}</div>
            </div>
          ))}
          {props.events.length === 0 && <div className="empty">Waiting for events…</div>}
        </div>
      </div>

      <div className="card">
        <h3>Mock Slack post (preview)</h3>
        {slack.length === 0 ? <div className="kv">No posts yet.</div> :
          slack.map((m, i) => (
            <div key={i} className="preview">
              <h4>{m.channel} · {m.ts.slice(0, 14)}</h4>
              <div>{m.text}</div>
            </div>
          ))}
      </div>

      <div className="card">
        <h3>Mock Outlook email + event (preview)</h3>
        {emails.length === 0 && calendar.length === 0 && <div className="kv">No emails or events yet.</div>}
        {emails.map((e, i) => (
          <div key={`e-${i}`} className="preview">
            <h4>EMAIL · {e.subject}</h4>
            <div>{e.description ?? ""}</div>
          </div>
        ))}
        {calendar.map((e, i) => (
          <div key={`c-${i}`} className="preview">
            <h4>EVENT · {e.subject} · {e.startsAt ? new Date(e.startsAt).toISOString() : ""}</h4>
            <div>{e.description ?? ""}</div>
          </div>
        ))}
      </div>

      {decisionPack ? (
        <div className="card">
          <h3>Decision Pack</h3>
          <pre className="diff">{JSON.stringify(decisionPack, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function summary(e: RunEvent): string {
  const d = e.detail as Record<string, unknown>;
  if (e.type === "STAGE_TRANSITION") return `${d["from"]} → ${d["to"]}`;
  if (e.type === "GATE_REQUESTED" || e.type === "GATE_APPROVED") return `${d["gate"]}${d["by"] ? ` by ${d["by"]}` : ""}`;
  if (e.type === "EVAL_RESULT") return `${d["name"]} score=${(d["score"] as number)?.toFixed?.(2)} threshold=${d["threshold"]} ${d["passed"] ? "PASS" : "FAIL"}`;
  if (e.type === "INTERVENTION") return JSON.stringify(d).slice(0, 120);
  if (e.type === "HEARTBEAT") return `cadence=${d["cadenceMs"]}ms drift=${d["driftMs"]}ms`;
  return JSON.stringify(d).slice(0, 120);
}
