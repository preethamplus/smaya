import React, { useState } from "react";
import { gql } from "../api.js";

interface Run { runId: string; stage: string; status: string; pendingGates: Array<{ runId: string; gate: string; expiresAt: number }> }

export function ApprovalsTab(props: { run: Run }): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [operator, setOperator] = useState<string>("recruiter@smaya.example.com");

  const approve = async (gate: string): Promise<void> => {
    setBusy(gate);
    setErr(null);
    try {
      await gql<{ approveGate: boolean }>(
        `mutation A($id: ID!, $g: String!, $o: String!) { approveGate(runId: $id, gate: $g, operator: $o) }`,
        { id: props.run.runId, g: gate, o: operator },
      );
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };
  const reject = async (gate: string): Promise<void> => {
    setBusy(gate);
    setErr(null);
    try {
      await gql<{ rejectGate: boolean }>(
        `mutation R($id: ID!, $g: String!, $o: String!, $r: String!) { rejectGate(runId: $id, gate: $g, operator: $o, reason: $r) }`,
        { id: props.run.runId, g: gate, o: operator, r: "rejected via UI" },
      );
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>Operator</h3>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} style={{ width: 360, padding: 6 }} />
      </div>
      {props.run.pendingGates.length === 0 && <div className="empty">No pending gates.</div>}
      {props.run.pendingGates.map((g) => (
        <div key={g.gate} className="card gate-card">
          <h3>{g.gate}</h3>
          <div className="kv"><b>run</b>{g.runId.slice(0, 8)}</div>
          <div className="kv"><b>expires</b>{new Date(g.expiresAt).toISOString().slice(0, 19).replace("T", " ")}</div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={busy === g.gate} onClick={() => approve(g.gate)}>Approve</button>
            <button className="btn" disabled={busy === g.gate} onClick={() => reject(g.gate)}>Reject</button>
          </div>
        </div>
      ))}
      {err && <div className="card" style={{ borderColor: "var(--bad)" }}>{err}</div>}
    </div>
  );
}
