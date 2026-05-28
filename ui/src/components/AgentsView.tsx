import { useEffect, useState } from "react";
import { fetchAgents } from "../api";
import type { Agent } from "../types";

export default function AgentsView({ initialAgents }: { initialAgents?: Agent[] }) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents ?? []);
  useEffect(() => {
    if (initialAgents) return;
    fetchAgents().then(setAgents).catch(() => setAgents([]));
  }, [initialAgents]);
  return (
    <div data-testid="agents-view">
      <div className="campaign-header">
        <div><h1>Agents</h1><div className="subtitle">{agents.length} reusable agent roles available for workflow stages</div></div>
      </div>
      <div className="adapter-notice" data-testid="adapter-notice">Advanced: runs choose the adapter at launch, and these role cards stay model-neutral.</div>
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
