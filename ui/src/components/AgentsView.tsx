import { useEffect, useState } from "react";
import { fetchAgents } from "../api";
import type { Agent } from "../types";
import { showToast } from "./Toast";

export default function AgentsView({ initialAgents }: { initialAgents?: Agent[] }) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents ?? []);
  const [loading, setLoading] = useState(initialAgents === undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (initialAgents) return;
    fetchAgents()
      .then((value) => {
        setAgents(value);
        setError(null);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        showToast(`Agents failed to load: ${message}`);
      })
      .finally(() => setLoading(false));
  }, [initialAgents]);
  return (
    <div data-testid="agents-view">
      <div className="campaign-header">
        <div><h1>Agents</h1><div className="subtitle">{agents.length} reusable agent roles available for workflow stages</div></div>
      </div>
      <div className="adapter-notice" data-testid="adapter-notice">Advanced: runs choose the adapter at launch, and these role cards stay model-neutral.</div>
      {error ? <div className="empty-state error-state" role="alert">Agents unavailable: {error}</div> : null}
      {!error && loading ? <div className="empty-state">Loading agents…</div> : null}
      {!error && !loading && agents.length === 0 ? <div className="empty-state">No agent roles configured.</div> : null}
      <div className="section"><div className="agents-grid">
        {agents.map((agent) => (
          <div className="kpi agent-card" key={agent.name}>
            <div className="agent-title"><span>{agent.name}</span><span>workflow role</span></div>
            <div className="agent-desc">{agent.description}</div>
            <div className="agent-tools">tools: {(agent.tools ?? []).join(", ")}</div>
          </div>
        ))}
      </div></div>
    </div>
  );
}
