import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "../types";
import { deleteTask, cancelTask, rerunTask, renameTask } from "../api";

const statusDot: Record<string, string> = {
  running: "bg-blue-500 animate-pulse",
  pending: "bg-rc-muted",
  awaiting_approval: "bg-rc-warning",
  completed: "bg-rc-success",
  failed: "bg-rc-error",
};

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function navTarget(task: Task) {
  switch (task.status) {
    case "pending": return `/task/${task.id}/discuss`;
    case "running": return `/task/${task.id}/monitor`;
    case "awaiting_approval": return `/task/${task.id}/plan`;
    default: return `/task/${task.id}/monitor`;
  }
}

export default function Sidebar({ tasks, selectedTaskId, onRefresh }: {
  tasks: Task[];
  onSelectTask?: (id: string) => void;
  selectedTaskId?: string;
  onRefresh?: () => void;
}) {
  const nav = useNavigate();
  const [menu, setMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const sorted = [...tasks].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleCtx = (e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, task });
  };

  const doDelete = async (t: Task) => {
    if (!confirm(`Delete task "${t.name}"?`)) return;
    await deleteTask(t.id);
    onRefresh?.();
    setMenu(null);
  };

  const doCancel = async (t: Task) => {
    await cancelTask(t.id);
    onRefresh?.();
    setMenu(null);
  };

  const doRerun = async (t: Task) => {
    await rerunTask(t.id);
    onRefresh?.();
    setMenu(null);
  };

  const commitRename = async (id: string) => {
    const trimmed = editName.trim();
    if (trimmed) {
      await renameTask(id, trimmed).catch(() => {});
      onRefresh?.();
    }
    setEditingId(null);
  };

  return (
    <aside className="w-56 bg-rc-bg border-r border-rc-border overflow-y-auto shrink-0 flex flex-col">
      <div className="p-3">
        <button onClick={() => nav("/task/new/discuss")} className="w-full btn-accent px-3 py-2.5 text-sm font-medium mb-2">
          + New Task
        </button>
        <button onClick={() => nav("/import")} className="w-full btn-ghost px-3 py-2 text-sm border border-rc-border mb-3">
          + Import Plan
        </button>
        <div className="space-y-1">
          {sorted.map((t) => (
            <button
              key={t.id}
              onClick={() => nav(navTarget(t))}
              onContextMenu={(e) => handleCtx(e, t)}
              className={`w-full text-left px-3 py-2 rounded-btn border transition-all ${
                selectedTaskId === t.id
                  ? "bg-rc-accent/10 border-l-2 border-l-rc-accent border-t-rc-border border-r-rc-border border-b-rc-border"
                  : "bg-rc-card border-rc-border hover:bg-rc-hover hover:border-rc-border-hover"
              }`}
            >
              <div className="flex items-center space-x-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[t.status] ?? "bg-rc-muted"}`} />
                {editingId === t.id ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => commitRename(t.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(t.id); if (e.key === "Escape") setEditingId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="text-sm text-rc-text bg-rc-code border border-rc-accent rounded px-1 flex-1 min-w-0 outline-none"
                  />
                ) : (
                  <span
                    className="text-sm text-rc-text truncate flex-1"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditingId(t.id); setEditName(t.name); }}
                  >{t.name}</span>
                )}
              </div>
              <div className="text-[10px] text-rc-muted mt-0.5 ml-4">{timeAgo(t.startedAt)}</div>
            </button>
          ))}
        </div>
      </div>

      {menu && (
        <div ref={menuRef} style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100 }}
          className="bg-rc-card border border-rc-border rounded-btn shadow-glow py-1 min-w-[140px]">
          {(menu.task.status === "running" || menu.task.status === "pending") && (
            <button onClick={() => doCancel(menu.task)} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Cancel</button>
          )}
          {(menu.task.status === "failed" || menu.task.status === "completed") && (
            <button onClick={() => doRerun(menu.task)} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Re-run</button>
          )}
          <button onClick={() => doDelete(menu.task)} className="w-full text-left px-3 py-1.5 text-sm text-rc-error hover:bg-rc-hover">Delete</button>
        </div>
      )}
    </aside>
  );
}
