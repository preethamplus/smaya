import React, { useEffect, useMemo, useState } from "react";
import { gql, subscribeRunEvents, type RunEvent } from "./api.js";
import { ActivityTab } from "./tabs/Activity.js";
import { ApprovalsTab } from "./tabs/Approvals.js";
import { AgentTab } from "./tabs/Agent.js";

interface RunStatus {
  runId: string;
  stage: string;
  status: string;
  costUsd: number;
  etaSec: number;
  goal: { topN: number; jdId: string; excludedCandidates: string[]; skipStages: string[] };
  pendingGates: Array<{ runId: string; gate: string; expiresAt: number }>;
}

type Tab = "activity" | "approvals" | "agent";

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("activity");
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);

  // Initial fetch + polling
  useEffect(() => {
    let mounted = true;
    const tick = async (): Promise<void> => {
      try {
        const data = await gql<{ runs: RunStatus[] }>(`{ runs { runId stage status costUsd etaSec goal pendingGates { runId gate expiresAt } } }`);
        if (!mounted) return;
        setRuns(data.runs);
        if (!activeRunId && data.runs[0]) setActiveRunId(data.runs[0].runId);
      } catch {
        /* server may not be up yet */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [activeRunId]);

  useEffect(() => subscribeRunEvents((e) => setEvents((prev) => [e, ...prev].slice(0, 500))), []);

  const activeRun = useMemo(() => runs.find((r) => r.runId === activeRunId), [runs, activeRunId]);
  const eventsForRun = useMemo(
    () => (activeRunId ? events.filter((e) => e.runId === activeRunId) : events),
    [events, activeRunId],
  );

  return (
    <div className="app">
      <div className="topbar">
        <h1>Smaya — Mission Console</h1>
        <div className="tabs">
          <div className={`tab ${tab === "activity" ? "active" : ""}`} onClick={() => setTab("activity")}>Activity</div>
          <div className={`tab ${tab === "approvals" ? "active" : ""}`} onClick={() => setTab("approvals")}>Approvals</div>
          <div className={`tab ${tab === "agent" ? "active" : ""}`} onClick={() => setTab("agent")}>Agent</div>
        </div>
        <div className="run-pill">
          {activeRun ? `${activeRun.stage} · ${activeRun.status} · $${activeRun.costUsd.toFixed(3)}` : "no active run"}
        </div>
      </div>
      <div className="layout">
        <aside className="sidebar">
          <h3>Runs</h3>
          {runs.length === 0 && <div className="kv">No runs yet. Start one with <code>npm run mission:run</code>.</div>}
          {runs.map((r) => (
            <div
              key={r.runId}
              className={`run-row ${r.runId === activeRunId ? "active" : ""}`}
              onClick={() => setActiveRunId(r.runId)}
            >
              <div>{r.stage}</div>
              <div className="id">{r.runId.slice(0, 8)} · {r.status}</div>
            </div>
          ))}
        </aside>
        <main className="main">
          {!activeRun && <div className="empty">Pick a run to inspect.</div>}
          {activeRun && tab === "activity" && <ActivityTab run={activeRun} events={eventsForRun} />}
          {activeRun && tab === "approvals" && <ApprovalsTab run={activeRun} />}
          {activeRun && tab === "agent" && <AgentTab run={activeRun} />}
        </main>
      </div>
    </div>
  );
}
