import { useState } from "react";
import type { Stage } from "../types";
import type { PlanStage } from "../types";

type NodeData = Stage | PlanStage;

const statusIcon: Record<string, string> = {
  complete: "✅", running: "●", pending: "○", failed: "❌", skipped: "○",
};

const borderColor: Record<string, string> = {
  running: "border-sky-400/45 bg-sky-500/10",
  complete: "border-emerald-400/45 bg-emerald-500/10",
  failed: "border-rose-400/45 bg-rose-500/10",
  pending: "border-rc-border bg-rc-card/85",
  skipped: "border-slate-500/45 bg-slate-500/10",
};

const badgeColor: Record<string, string> = {
  running: "border-sky-400/35 bg-sky-500/10 text-sky-100",
  complete: "border-emerald-400/35 bg-emerald-500/10 text-emerald-100",
  failed: "border-rose-400/35 bg-rose-500/10 text-rose-100",
  pending: "border-rc-border bg-rc-code/70 text-rc-text-secondary",
  skipped: "border-slate-400/35 bg-slate-500/10 text-slate-200",
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
    <div
      onClick={onClick}
      className={`glass-panel rounded-card border px-4 py-3 ${borderColor[status] ?? "border-rc-border bg-rc-card"} ${
        onClick ? "cursor-pointer hover:border-rc-border-hover" : ""
      } ${status === "running" ? "shadow-glow" : ""} transition-all`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 text-sm">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="truncate text-sm font-semibold text-rc-text">{node.id}</span>
            <span className={`rounded-input border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${badgeColor[status] ?? badgeColor.pending}`}>
              {status}
            </span>
            {isPlan && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                className="ml-auto rounded-input bg-rc-hover px-1.5 py-0.5 text-xs text-rc-text-secondary transition hover:bg-rc-border"
              >
                {expanded ? "▾" : "▸"}
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-rc-text-secondary">
            <span className="rounded-input bg-rc-code px-1.5 py-0.5 font-mono font-bold uppercase tracking-[0.18em]">{node.role}</span>
            {duration && <span className="font-mono text-rc-success">{duration}</span>}
            {isStage(node) && node.retries > 0 && <span className="font-mono text-amber-100">Attempt {node.retries + 1}</span>}
            {isStage(node) && status === "complete" && <span className="text-rc-success">✓ Settled</span>}
            {"timeout_ms" in node && <span className="font-mono">{node.timeout_ms / 1000}s timeout</span>}
          </div>
        </div>
      </div>

      {expanded && ("prompt_template" in node || "task" in node) && (
        <pre className="mt-3 whitespace-pre-wrap rounded-card bg-rc-code p-3 font-mono text-xs text-rc-text-secondary">{(node as PlanStage).prompt_template || (node as PlanStage).task || ""}</pre>
      )}
    </div>
  );
}
