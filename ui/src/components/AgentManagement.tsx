import { useState, useEffect } from 'react';
import type { Agent } from '../types';
import { fetchAgents, fetchAgent } from '../api';

const roleIcon: Record<string, string> = {
  coder: "💻", qa: "✅", paper_writer: "✍️", paper_reviewer: "📝",
  ai_detector: "🔎", researcher: "🔍", doc_writer: "📄", doc_reviewer: "📝",
  planner: "📋", discussion: "💬",
};

export default function AgentManagement() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [yaml, setYaml] = useState('');

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const selectAgent = (i: number) => {
    setSelectedIdx(i);
    fetchAgent(agents[i].name)
      .then(setYaml)
      .catch(() => setYaml('# Failed to load agent YAML'));
  };

  if (loading) return <div className="text-rc-muted">Loading…</div>;
  if (error && !agents.length) return <div className="text-rc-error">Error: {error}</div>;

  return (
    <div className="flex h-full space-x-6">
      <div className="flex-1 overflow-auto">
        <h2 className="text-sm font-semibold text-rc-text mb-4">Agents</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {agents.map((a, i) => (
            <div key={a.name} onClick={() => selectAgent(i)}
              className={`glass-panel rounded-card p-4 cursor-pointer transition-all ${
                selectedIdx === i ? 'border-rc-accent shadow-glow' : 'hover:border-rc-border-hover'
              }`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{roleIcon[a.name] ?? "🤖"}</span>
                <span className="font-medium text-rc-text">{a.name}</span>
              </div>
              <p className="text-xs text-rc-text-secondary mb-2">{a.description}</p>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-rc-muted bg-rc-code px-1.5 py-0.5 rounded-input">{a.model}</span>
                {a.tools.slice(0, 3).map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 bg-rc-accent/10 text-rc-accent rounded-input">{t}</span>
                ))}
                {a.tools.length > 3 && <span className="text-[10px] text-rc-muted">+{a.tools.length - 3}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="w-96 shrink-0 flex flex-col">
        <h3 className="text-xs font-bold text-rc-muted uppercase tracking-wider mb-2">Agent YAML</h3>
        <pre className="flex-1 bg-rc-code border border-rc-border rounded-card p-4 font-mono text-xs text-rc-text-secondary overflow-auto whitespace-pre-wrap">
          {yaml || 'Select an agent to view...'}
        </pre>
      </div>
    </div>
  );
}
