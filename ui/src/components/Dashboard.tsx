import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "../types";
import Sparkline from "./Sparkline";
import AlertsFeed from "./AlertsFeed";
import TaskCard from "./TaskCard";
import { renameTask, deleteTask, cancelTask, rerunTask } from "../api";
import { useRefreshTasks } from "./Layout";

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function navTarget(task: Task) {
  switch (task.status) {
    case "pending": return `/task/${task.id}/discuss`;
    case "running": return `/task/${task.id}/monitor`;
    case "awaiting_approval": return `/task/${task.id}/plan`;
    default: return `/task/${task.id}/monitor`;
  }
}

const phaseIcon: Record<string, string> = {
  running: "🔄",
  pending: "⏳",
  awaiting_approval: "⏸",
  completed: "✅",
  failed: "❌",
};

function ProgressBar({ stages }: { stages: Task["stages"] }) {
  const total = stages.length || 1;
  const done = stages.filter(s => s.status === "complete" || s.status === "skipped").length;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-rc-code rounded-full overflow-hidden">
        <div className="h-full bg-rc-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-rc-muted">{pct}%</span>
    </div>
  );
}

function GatesSummary({ stages }: { stages: Task["stages"] }) {
  const gates = stages.filter(s => s.isGate);
  if (gates.length === 0) return <span className="text-rc-muted">—</span>;
  const passed = gates.filter(s => s.status === "complete").length;
  return <span className="font-mono">{passed}/{gates.length}</span>;
}

function EditableTaskName({ task, forceEdit, onEditDone }: { task: Task; forceEdit?: boolean; onEditDone?: () => void }) {
  const refresh = useRefreshTasks();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (forceEdit && !editing) setEditing(true); }, [forceEdit]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commitRename = async () => {
    setEditing(false);
    onEditDone?.();
    const trimmed = editName.trim();
    if (trimmed && trimmed !== task.name) {
      try { await renameTask(task.id, trimmed); refresh(); } catch { setEditName(task.name); }
    } else {
      setEditName(task.name);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-testid="rename-input"
        className="text-sm text-rc-text bg-rc-code border border-rc-border rounded-input px-1 w-full"
        value={editName}
        onClick={e => e.stopPropagation()}
        onChange={e => setEditName(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => {
          if (e.key === "Enter") commitRename();
          if (e.key === "Escape") { setEditing(false); setEditName(task.name); }
        }}
      />
    );
  }

  return (
    <span
      data-testid="task-name"
      className="text-sm text-rc-text truncate max-w-[200px] cursor-text"
      onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
    >
      {task.name}
    </span>
  );
}

export default function Dashboard({ tasks }: { tasks: Task[] }) {
  const nav = useNavigate();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleCtx = (e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, task });
  };

  const doRename = () => { if (ctxMenu) { setEditingId(ctxMenu.task.id); setCtxMenu(null); } };
  const doDelete = async () => { if (ctxMenu) { await deleteTask(ctxMenu.task.id); setCtxMenu(null); } };
  const doRerun = async () => { if (ctxMenu) { const res = await rerunTask(ctxMenu.task.id); setCtxMenu(null); nav(res.route === 'monitor' ? `/task/${ctxMenu.task.id}/monitor` : `/task/${ctxMenu.task.id}/discuss`); } };
  const doCancel = async () => { if (ctxMenu) { await cancelTask(ctxMenu.task.id); setCtxMenu(null); } };
  const doCreateCampaign = async () => {
    if (!ctxMenu) return;
    const name = ctxMenu.task.name.toLowerCase().replace(/\s+/g, '-');
    await fetch(`/api/tasks/${ctxMenu.task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: name, campaignSeq: 1 }),
    }).catch(() => {});
    setCtxMenu(null);
  };

  const sorted = [...tasks].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  // Group by campaign
  const campaigns = new Map<string, Task[]>();
  const ungrouped: Task[] = [];
  for (const t of sorted) {
    if (t.campaignId) {
      if (!campaigns.has(t.campaignId)) campaigns.set(t.campaignId, []);
      campaigns.get(t.campaignId)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-rc-muted gap-4">
        <p>No tasks</p>
        <div className="flex gap-2">
          <button onClick={() => nav("/task/new/discuss")} className="btn-accent px-4 py-2 text-sm">+ New Task</button>
          <button onClick={() => nav("/import")} className="btn-ghost px-4 py-2 text-sm border border-rc-border">Import</button>
        </div>
      </div>
    );
  }

  const useCards = tasks.length <= 3;

  const renderRow = (t: Task) => {
    const expanded = expandedId === t.id;
    return (
      <tbody key={t.id}>
        <tr
          className="border-b border-rc-border hover:bg-rc-hover cursor-pointer transition-colors"
          onClick={() => setExpandedId(expanded ? null : t.id)}
          onDoubleClick={() => nav(navTarget(t))}
          onContextMenu={(e) => handleCtx(e, t)}
        >
          <td className="px-3 py-2"><EditableTaskName task={t} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} /></td>
          <td className="px-3 py-2 text-xs">
            <span>{phaseIcon[t.status] ?? ""} {t.status}</span>
          </td>
          <td className="px-3 py-2"><ProgressBar stages={t.stages} /></td>
          <td className="px-3 py-2">
            {t.bestScore != null ? <Sparkline values={[t.bestScore]} /> : <span className="text-rc-muted">—</span>}
          </td>
          <td className="px-3 py-2 text-xs font-mono text-rc-text">{t.bestScore?.toFixed(2) ?? "—"}</td>
          <td className="px-3 py-2 text-xs"><GatesSummary stages={t.stages} /></td>
          <td className="px-3 py-2 text-xs font-mono text-rc-muted">{fmtDuration(t.elapsed_ms)}</td>
        </tr>
        {expanded && (
          <tr>
            <td colSpan={7} className="px-6 py-3 bg-rc-code/50">
              <div className="text-xs space-y-1">
                <div className="font-bold text-rc-muted uppercase tracking-wider mb-1">Iteration History</div>
                {t.iterationLog ? (
                  <pre className="text-rc-text-secondary whitespace-pre-wrap font-mono text-[11px] max-h-40 overflow-auto">{t.iterationLog}</pre>
                ) : (
                  <span className="text-rc-muted">No iteration history</span>
                )}
              </div>
              <button onClick={() => nav(navTarget(t))} className="mt-2 text-xs text-rc-accent hover:underline">
                Open Monitor →
              </button>
            </td>
          </tr>
        )}
      </tbody>
    );
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-rc-text">Dashboard</h2>
        <button onClick={() => nav("/import")} className="btn-ghost px-3 py-1.5 text-sm border border-rc-border">Import</button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {useCards ? (
          <div className="flex flex-col gap-4" data-testid="card-layout">
            {[...campaigns.entries()].map(([cid, cTasks]) => (
              <div key={`camp-${cid}`}>
                <div className="text-xs font-semibold text-rc-accent mb-2">📊 Campaign: {cid}</div>
                <div className="flex flex-wrap gap-4">
                  {cTasks.map(t => (
                    <div key={t.id} className="w-full sm:w-[calc(50%-0.5rem)] lg:w-[calc(33.333%-0.75rem)]">
                      <TaskCard task={t} onContextMenu={(e) => handleCtx(e, t)} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {ungrouped.length > 0 && (
              <div className="flex flex-wrap gap-4">
                {ungrouped.map(t => (
                  <div key={t.id} className="w-full sm:w-[calc(50%-0.5rem)] lg:w-[calc(33.333%-0.75rem)]">
                    <TaskCard task={t} onContextMenu={(e) => handleCtx(e, t)} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <table className="w-full text-left" data-testid="table-layout">
            <thead className="sticky top-0 bg-rc-bg border-b border-rc-border">
              <tr>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Task</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Phase</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Progress</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Score Trend</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Best</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Gates</th>
                <th className="px-3 py-2 text-[10px] font-bold text-rc-muted uppercase tracking-wider">Time</th>
              </tr>
            </thead>
            {/* Campaign groups */}
            {[...campaigns.entries()].map(([cid, cTasks]) => (
              <tbody key={`campaign-${cid}`}>
                <tr className="bg-rc-card/50 border-b border-rc-border">
                  <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-rc-accent">
                    📊 Campaign: {cid}
                  </td>
                  <td className="px-3 py-1.5">
                    <Sparkline values={cTasks.map(t => t.bestScore ?? 0).filter(Boolean)} />
                  </td>
                  <td className="px-3 py-1.5 text-xs font-mono text-rc-text">
                    {Math.max(...cTasks.map(t => t.bestScore ?? 0)).toFixed(2)}
                  </td>
                  <td colSpan={2} className="px-3 py-1.5 text-xs text-rc-muted">{cTasks.length} runs</td>
                </tr>
                {cTasks.map(t => {
                  const expanded = expandedId === t.id;
                  return (
                    <tbody key={t.id}>
                      <tr
                        className="border-b border-rc-border hover:bg-rc-hover cursor-pointer transition-colors pl-4"
                        onClick={() => setExpandedId(expanded ? null : t.id)}
                        onDoubleClick={() => nav(navTarget(t))}
                        onContextMenu={(e) => handleCtx(e, t)}
                      >
                        <td className="px-3 py-2 pl-6"><EditableTaskName task={t} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} /></td>
                        <td className="px-3 py-2 text-xs">{phaseIcon[t.status] ?? ""} {t.status}</td>
                        <td className="px-3 py-2"><ProgressBar stages={t.stages} /></td>
                        <td className="px-3 py-2">{t.bestScore != null ? <Sparkline values={[t.bestScore]} /> : <span className="text-rc-muted">—</span>}</td>
                        <td className="px-3 py-2 text-xs font-mono text-rc-text">{t.bestScore?.toFixed(2) ?? "—"}</td>
                        <td className="px-3 py-2 text-xs"><GatesSummary stages={t.stages} /></td>
                        <td className="px-3 py-2 text-xs font-mono text-rc-muted">{fmtDuration(t.elapsed_ms)}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={7} className="px-6 py-3 bg-rc-code/50">
                            <div className="text-xs space-y-1">
                              <div className="font-bold text-rc-muted uppercase tracking-wider mb-1">Iteration History</div>
                              {t.iterationLog ? (
                                <pre className="text-rc-text-secondary whitespace-pre-wrap font-mono text-[11px] max-h-40 overflow-auto">{t.iterationLog}</pre>
                              ) : <span className="text-rc-muted">No iteration history</span>}
                            </div>
                            <button onClick={() => nav(navTarget(t))} className="mt-2 text-xs text-rc-accent hover:underline">Open Monitor →</button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  );
                })}
              </tbody>
            ))}
            {/* Ungrouped tasks */}
            {ungrouped.map(renderRow)}
          </table>
        )}
      </div>

      {/* Alerts feed */}
      <div className="shrink-0 glass-panel rounded-card p-3">
        <h3 className="text-[10px] font-bold text-rc-muted uppercase tracking-wider mb-2">Recent Events</h3>
        <AlertsFeed tasks={tasks} />
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div ref={ctxRef} data-testid="context-menu" style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 100 }}
          className="bg-rc-card border border-rc-border rounded-btn shadow-glow py-1 min-w-[140px]">
          <button data-testid="ctx-rename" onClick={doRename} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Rename</button>
          {(ctxMenu.task.status === "failed" || ctxMenu.task.status === "completed") && (
            <button data-testid="ctx-rerun" onClick={doRerun} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Rerun</button>
          )}
          {(ctxMenu.task.status === "running" || ctxMenu.task.status === "pending") && (
            <button data-testid="ctx-cancel" onClick={doCancel} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Cancel</button>
          )}
          <button data-testid="ctx-delete" onClick={doDelete} className="w-full text-left px-3 py-1.5 text-sm text-rc-error hover:bg-rc-hover">Delete</button>
          {!ctxMenu.task.campaignId && (
            <button data-testid="ctx-campaign" onClick={doCreateCampaign} className="w-full text-left px-3 py-1.5 text-sm text-rc-text hover:bg-rc-hover">Create campaign</button>
          )}
        </div>
      )}
    </div>
  );
}
