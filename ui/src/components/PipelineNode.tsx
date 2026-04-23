import { useState } from "react";
import type { Stage } from "../types";
import type { PlanStage } from "../types";

type NodeData = Stage | PlanStage;

const statusIcon: Record<string, string> = {
  complete: "✅", running: "●", pending: "○", failed: "❌", skipped: "○",
};

const borderColor: Record<string, string> = {
  running: "border-l-rc-accent",
  complete: "border-l-rc-success",
  failed: "border-l-rc-error",
  pending: "border-l-rc-muted",
  skipped: "border-l-rc-muted",
};

function isStage(n: NodeData): n is Stage {
  return "status" in n && "retries" in n;
}

export default function PipelineNode({ node, onClick }: { node: NodeData; onClick?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const status = isStage(node) ? node.status : "pending";
  const icon = statusIcon[status] ?? "○";
  const duration = isStage(node) && node.duration_ms ? ((node.duration_ms) / 1000).toFixed(1) + "s" : null;
  const isPlan = !isStage(node);

  return (
    <div onClick={onClick}
      className={`glass-panel rounded-card px-4 py-3 border-l-4 ${borderColor[status] ?? "border-l-rc-muted"} ${
        status === "running" ? "animate-pulse border-rc-accent shadow-glow" : ""
      } ${onClick ? "cursor-pointer hover:border-rc-border-hover" : ""} transition-all`}>
      <div className="flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="text-sm font-semibold text-rc-text truncate">{node.id}</span>
        {isPlan && (
          <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="ml-auto px-1.5 py-0.5 bg-rc-hover hover:bg-rc-border rounded-input text-xs text-rc-text-secondary transition">
            {expanded ? "▾" : "▸"}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-rc-text-secondary">
        <span className="font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-input bg-rc-card font-mono">{node.role}</span>
        {duration && <span className="font-mono text-rc-success">{duration}</span>}
        {isStage(node) && status === "complete" && <span className="text-rc-success">✓</span>}
        {"timeout_ms" in node && <span className="font-mono">{(node.timeout_ms / 1000)}s</span>}
      </div>
      {expanded && "prompt_template" in node && (
        <pre className="mt-3 text-xs font-mono text-rc-text-secondary bg-rc-code rounded-card p-3 whitespace-pre-wrap">{node.prompt_template}</pre>
      )}
    </div>
  );
}
