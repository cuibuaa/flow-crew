import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getCampaignDisplayName, getCampaignIteration } from "../types";
import type { Task } from "../types";
import Sparkline from "./Sparkline";
import AlertsFeed from "./AlertsFeed";
import TaskCard from "./TaskCard";
import NewTaskDialog from "./NewTaskDialog";
import { createTask, renameTask, deleteTask, cancelTask, rerunTask, updateTask, fetchCampaigns, fetchCampaign } from "../api";
import { useRefreshTasks, useRemoveTask } from "./Layout";

type CampaignScoreData = {
  bestScore: number | null;
  values: number[];
};

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

function waitForMenuDismissPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
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

function CampaignStateSummary({ task }: { task: Task }) {
  const hasCampaignContext = Boolean(task.campaignId);
  const campaignIteration = getCampaignIteration(task);

  if (!hasCampaignContext && !task.researchInjection && task.currentIteration <= 1) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-rc-text-secondary">
      {task.campaignId && (
        <span className="font-mono rounded-input bg-rc-card px-2 py-0.5">
          {getCampaignDisplayName(task)} #{task.campaignSeq ?? "?"}
        </span>
      )}
      {task.campaignId && (
        <span className="rounded-input border border-rc-border px-2 py-0.5 font-mono">
          Campaign iteration {campaignIteration}
        </span>
      )}
      <span className="font-mono">Run iteration {task.currentIteration}/{task.maxIterations}</span>
      {task.researchInjection && (
        <span className="rounded-input border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-amber-100">
          Research injected
        </span>
      )}
    </div>
  );
}

function TaskIdentityCell({ task, forceEdit, onEditDone }: { task: Task; forceEdit?: boolean; onEditDone?: () => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <EditableTaskName task={task} forceEdit={forceEdit} onEditDone={onEditDone} />
        {task.researchInjection && (
          <span className="rounded-input border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-100">
            Research injected
          </span>
        )}
      </div>
      {(task.campaignId || task.currentIteration > 1) && (
        <div className="text-[10px] text-rc-muted">
          {task.campaignId
            ? `Campaign iteration ${getCampaignIteration(task)}`
            : `Run iteration ${task.currentIteration}/${task.maxIterations}`}
        </div>
      )}
    </div>
  );
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
  const refresh = useRefreshTasks();
  const removeTask = useRemoveTask();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [campaignScores, setCampaignScores] = useState<Record<string, CampaignScoreData>>({});
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

  useEffect(() => {
    const campaignIds = Array.from(new Set(tasks.flatMap((task) => (
      [task.campaignId, task.campaignStorageKey].filter((id): id is string => Boolean(id))
    ))));
    if (campaignIds.length === 0) {
      setCampaignScores({});
      return;
    }

    let cancelled = false;
    Promise.all([
      fetchCampaigns().catch(() => []),
      Promise.all(campaignIds.map(async (id) => {
        const entries = await fetchCampaign(id).catch(() => []);
        return [id, entries.map((entry) => entry.score).filter((score) => Number.isFinite(score))] as const;
      })),
    ]).then(([summaries, histories]) => {
      if (cancelled) return;
      const next: Record<string, CampaignScoreData> = {};
      for (const summary of summaries) {
        next[summary.id] = { bestScore: summary.bestScore, values: [] };
      }
      for (const [id, values] of histories) {
        const historyBest = values.length > 0 ? Math.max(...values) : null;
        next[id] = {
          bestScore: next[id]?.bestScore ?? historyBest,
          values,
        };
      }
      setCampaignScores(next);
    });

    return () => { cancelled = true; };
  }, [tasks]);

  const getCampaignScoreData = (campaignId: string, campaignTasks: Task[]): CampaignScoreData => {
    const keys = Array.from(new Set([
      campaignId,
      ...campaignTasks.flatMap((task) => [task.campaignStorageKey, task.campaignId]),
    ].filter((id): id is string => Boolean(id))));
    let fallback: CampaignScoreData | null = null;
    for (const key of keys) {
      const scoreData = campaignScores[key];
      if (!scoreData) continue;
      if (scoreData.values.length > 0) return scoreData;
      fallback = fallback ?? scoreData;
    }
    return fallback ?? { bestScore: null, values: [] };
  };

  const doRename = () => { if (ctxMenu) { setEditingId(ctxMenu.task.id); setCtxMenu(null); } };
  const doDelete = async () => {
    if (!ctxMenu) return;
    const task = ctxMenu.task;
    setCtxMenu(null);
    await waitForMenuDismissPaint();
    if (!confirm(`Delete task "${task.name}"?`)) return;
    removeTask(task.id);
    try {
      await deleteTask(task.id);
      void refresh();
    } catch (err) {
      alert(`Could not delete "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
      void refresh();
    }
  };
  const doRerun = async () => {
    if (!ctxMenu) return;
    const task = ctxMenu.task;
    setCtxMenu(null);
    try {
      const res = await rerunTask(task.id);
      refresh();
      nav(res.route === 'monitor' ? `/task/${task.id}/monitor` : `/task/${task.id}/discuss`);
    } catch (err) {
      alert(`Could not rerun "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const doCancel = async () => {
    if (!ctxMenu) return;
    const task = ctxMenu.task;
    setCtxMenu(null);
    try {
      await cancelTask(task.id);
      refresh();
    } catch (err) {
      alert(`Could not cancel "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const doCreateCampaign = async () => {
    if (!ctxMenu) return;
    const name = ctxMenu.task.name;
    const taskId = ctxMenu.task.id;
    setCtxMenu(null);
    await updateTask(taskId, { campaignName: name }).catch(() => {});
    refresh();
  };

  const handleNewTask = async (name: string, campaignId?: string, campaignName?: string) => {
    setNewTaskOpen(false);
    try {
      const { id } = await createTask({ name, workflow: "default", discussion: [], plan: [], campaignId, campaignName });
      nav(`/task/${id}/discuss`);
    } catch {
      // Ignore create failures here; navbar remains available.
    }
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
      <div className="h-full">
        <div className="flex flex-col items-center justify-center h-full text-rc-muted gap-4">
          <p>No tasks</p>
          <div className="flex gap-2">
            <button onClick={() => setNewTaskOpen(true)} className="btn-accent px-4 py-2 text-sm">+ New Task</button>
            <button onClick={() => nav("/import")} className="btn-ghost px-4 py-2 text-sm border border-rc-border">Import</button>
          </div>
        </div>
        <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onSubmit={handleNewTask} />
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
          <td className="px-3 py-2">
            <TaskIdentityCell task={t} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} />
          </td>
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
              <div className="text-xs space-y-2">
                <CampaignStateSummary task={t} />
                {t.researchInjection && (
                  <div className="rounded-card border border-amber-300/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                    Research injected at campaign iteration {t.researchInjection.iteration}: {t.researchInjection.message}
                  </div>
                )}
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
                <div className="text-xs font-semibold text-rc-accent mb-2">📊 Campaign: {getCampaignDisplayName(cTasks[0] ?? { campaignId: cid })}</div>
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
            {[...campaigns.entries()].map(([cid, cTasks]) => {
              const scoreData = getCampaignScoreData(cid, cTasks);
              return (
              <tbody key={`campaign-${cid}`}>
                <tr className="bg-rc-card/50 border-b border-rc-border">
                  <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-rc-accent">
                    📊 Campaign: {getCampaignDisplayName(cTasks[0] ?? { campaignId: cid })}
                  </td>
                  <td className="px-3 py-1.5">
                    {scoreData.values.length > 0 ? <Sparkline values={scoreData.values} /> : <span className="text-rc-muted">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-xs font-mono text-rc-text">
                    {scoreData.bestScore != null ? scoreData.bestScore.toFixed(2) : <span className="text-rc-muted">—</span>}
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
                        <td className="px-3 py-2 pl-6">
                          <TaskIdentityCell task={t} forceEdit={editingId === t.id} onEditDone={() => setEditingId(null)} />
                        </td>
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
                            <div className="text-xs space-y-2">
                              <CampaignStateSummary task={t} />
                              {t.researchInjection && (
                                <div className="rounded-card border border-amber-300/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                                  Research injected at campaign iteration {t.researchInjection.iteration}: {t.researchInjection.message}
                                </div>
                              )}
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
              );
            })}
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
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onSubmit={handleNewTask} />
    </div>
  );
}
