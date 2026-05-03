import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getCampaignDisplayName, getCampaignIteration } from "../types";
import type { Task } from "../types";
import { renameTask } from "../api";

const statusIcon: Record<string, string> = {
  complete: "✅", running: "🔄", pending: "⏳", failed: "❌", skipped: "⏭", awaiting_approval: "⏸️",
};

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function TaskCard({ task, onContextMenu, forceEdit, onEditDone }: { task: Task; onContextMenu?: (e: React.MouseEvent) => void; forceEdit?: boolean; onEditDone?: () => void }) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const done = task.stages.filter(s => s.status === "complete" || s.status === "skipped").length;
  const total = task.stages.length || 1;
  const pct = Math.round((done / total) * 100);
  const gates = task.stages.filter(s => s.isGate);
  const gatesPassed = gates.filter(s => s.status === "complete").length;

  useEffect(() => { if (forceEdit && !editing) setEditing(true); }, [forceEdit]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = async () => {
    setEditing(false);
    onEditDone?.();
    const trimmed = editName.trim();
    if (trimmed && trimmed !== task.name) {
      try { await renameTask(task.id, trimmed); } catch { setEditName(task.name); }
    } else {
      setEditName(task.name);
    }
  };

  const target = task.status === "pending" ? `/task/${task.id}/discuss`
    : task.status === "awaiting_approval" ? `/task/${task.id}/plan`
    : `/task/${task.id}/monitor`;

  return (
    <div
      className="glass-panel rounded-card p-4 cursor-pointer transition-all hover:border-rc-border-hover"
      onClick={() => nav(target)}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-center justify-between mb-2">
        {editing ? (
          <input
            ref={inputRef}
            data-testid="rename-input"
            className="text-sm font-semibold text-rc-text bg-rc-code border border-rc-border rounded-input px-1"
            value={editName}
            onClick={e => e.stopPropagation()}
            onChange={e => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setEditing(false); setEditName(task.name); }
            }}
          />
        ) : (
          <span
            className="font-semibold text-sm text-rc-text"
            data-testid="task-name"
            onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
          >
            {task.name}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-rc-text-secondary mb-2">
        <span>{statusIcon[task.status === "completed" ? "complete" : task.status] ?? "⏳"} {task.status}</span>
        <div className="flex items-center gap-1">
          <div className="w-20 h-2 bg-rc-code rounded-full overflow-hidden">
            <div className="h-full bg-rc-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[10px] font-mono">{pct}%</span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-rc-text-secondary mb-2">
        {task.bestScore != null && <span>Best: {task.bestScore.toFixed(2)}</span>}
        {gates.length > 0 && <span>Gates: {gatesPassed}/{gates.length}</span>}
        <span>{fmtTime(task.elapsed_ms)} elapsed</span>
      </div>

      {(task.campaignId || task.currentIteration > 1 || task.researchInjection) && (
        <div className="flex items-center gap-2 text-[11px] text-rc-text-secondary mb-2">
          {task.campaignId && (
            <span className="font-mono rounded-input bg-rc-code px-2 py-0.5">
              {getCampaignDisplayName(task)} #{task.campaignSeq ?? "?"}
            </span>
          )}
          {task.campaignId && <span className="font-mono">Campaign iteration {getCampaignIteration(task)}</span>}
          <span className="font-mono">Run iteration {task.currentIteration}/{task.maxIterations}</span>
          {task.researchInjection && (
            <span className="rounded-input border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-amber-100">
              Research injected
            </span>
          )}
        </div>
      )}

      {task.stages.length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10px]" data-testid="mini-pipeline">
          {task.stages.map((s, i) => (
            <span key={s.id} className="text-rc-text-secondary">
              {i > 0 && <span className="mx-0.5">→</span>}
              {s.id} {statusIcon[s.status] ?? "⏳"}
            </span>
          ))}
        </div>
      )}

      {task.failureReason && (
        <div className="mt-2 text-xs text-rose-300 truncate" title={task.failureReason}>
          {task.failureReason}
        </div>
      )}
    </div>
  );
}
