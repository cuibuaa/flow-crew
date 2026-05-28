import type { RunStage } from "../types";

export function stageDepths(stages: RunStage[]): Record<string, number> {
  const safeStages = stages.filter((stage) => stage?.id);
  const byId = new Map(safeStages.map((stage) => [stage.id, stage]));
  const memo: Record<string, number> = {};
  const depth = (id: string, seen = new Set<string>()): number => {
    if (memo[id] != null) return memo[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const stage = byId.get(id);
    const deps = stage?.depends_on ?? [];
    memo[id] = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depth(dep, seen))) + 1;
    return memo[id];
  };
  for (const stage of safeStages) depth(stage.id);
  return memo;
}

const statusColors: Record<string, string> = { complete: "#4ade80", completed: "#4ade80", running: "#5b9eff", pending: "#6b748a", skipped: "#a78bfa", failed: "#f87171" };

export default function StageDAG({ stages, selectedStageId, onSelect }: { stages?: RunStage[]; selectedStageId?: string; onSelect?: (stageId: string) => void }) {
  const safeStages = (stages ?? []).filter((stage) => stage?.id);
  if (safeStages.length === 0) {
    return <div className="run-dag empty-state" data-testid="stage-dag-empty">no stages recorded</div>;
  }
  const depths = stageDepths(safeStages);
  const maxDepth = Math.max(0, ...Object.values(depths));
  const byDepth = new Map<number, RunStage[]>();
  for (const stage of safeStages) {
    const d = depths[stage.id] ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), stage]);
  }
  const width = 860;
  const height = 300;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, group] of byDepth) {
    const x = (width / (maxDepth + 1.5)) * (depth + 0.5) + 40;
    const rowH = height / (group.length + 1);
    group.forEach((stage, index) => positions.set(stage.id, { x, y: rowH * (index + 1) }));
  }
  return (
    <div className="run-dag" data-testid="stage-dag">
      <svg viewBox={`0 0 ${width} ${height}`}>
        <defs><marker id="stagearrow-react" viewBox="0 -5 10 10" refX="38" refY="0" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,-5L10,0L0,5" fill="#3a4a6a" /></marker></defs>
        {safeStages.flatMap((stage) => (stage.depends_on ?? []).map((dep) => {
          const a = positions.get(dep);
          const b = positions.get(stage.id);
          if (!a || !b) return null;
          return <line key={`${dep}-${stage.id}`} data-testid="dag-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#3a4a6a" strokeWidth="1.5" markerEnd="url(#stagearrow-react)" />;
        }))}
        {safeStages.flatMap((stage) => (stage.retry_to ?? []).map((target) => {
          const a = positions.get(stage.id);
          const b = positions.get(target);
          if (!a || !b) return null;
          return <path key={`${stage.id}-retry-${target}`} data-testid="dag-retry-edge" d={`M${a.x},${a.y} Q${(a.x + b.x) / 2},${(a.y + b.y) / 2 - 30} ${b.x},${b.y}`} fill="none" stroke="#fbbf24" strokeDasharray="4 3" strokeWidth="1.2" />;
        }))}
        {safeStages.map((stage) => {
          const p = positions.get(stage.id);
          if (!p) return null;
          const color = statusColors[stage.status] ?? "#94a3b8";
          const selected = selectedStageId === stage.id;
          return (
            <g key={stage.id} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect?.(stage.id)} data-testid={`dag-node-${stage.id}`} data-depth={depths[stage.id]} style={{ cursor: "pointer" }}>
              <rect x="-65" y="-22" width="130" height="44" rx="6" fill={`${color}22`} stroke={selected ? "#ffffff" : color} strokeWidth={selected ? 2.5 : 1.5} data-selected={selected ? "true" : "false"} />
              <text textAnchor="middle" y="-3" fill={color} fontSize="11" fontWeight="600">{stage.id.length > 14 ? `${stage.id.slice(0, 13)}…` : stage.id}</text>
              <text textAnchor="middle" y="12" fill="#b0bacb" fontSize="10">{stage.role}{stage.is_gate ? " · gate" : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
