import { useMemo, useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTasks } from "./Layout";
import { fetchTask, rerunFromHere, reevalGate, cancelTask } from "../api";
import PipelineNode from "./PipelineNode";
import type { Stage, Task } from "../types";

/* ── helpers ─────────────────────────────────────────────────── */

function computeDepths(stages: Stage[]): Map<string, number> {
  const memo = new Map<string, number>();
  const ids = new Set(stages.map((s) => s.id));
  const get = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const s = stages.find((x) => x.id === id);
    if (!s || s.dependsOn.length === 0) { memo.set(id, 0); return 0; }
    const d = 1 + Math.max(...s.dependsOn.filter((dep) => ids.has(dep)).map(get));
    memo.set(id, d);
    return d;
  };
  for (const s of stages) get(s.id);
  return memo;
}

/** Compute average duration of completed stages */
function avgDuration(stages: Stage[]): number {
  const done = stages.filter((s) => s.status === "complete" && s.duration_ms);
  if (done.length === 0) return 0;
  return done.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0) / done.length;
}

interface HealthInfo {
  slow?: boolean;
  stalled?: boolean;
  timeoutSoon?: boolean;
  elapsedMs: number;
}

function getStageHealth(stage: Stage, avg: number, _timeoutMs?: number): HealthInfo {
  if (stage.status !== "running" || !stage.startedAt) return { elapsedMs: 0 };
  const elapsed = Date.now() - Date.parse(stage.startedAt);
  return {
    slow: avg > 0 && elapsed > 2 * avg,
    stalled: avg > 0 && elapsed > 3 * avg,
    timeoutSoon: _timeoutMs ? elapsed > 0.8 * _timeoutMs : false,
    elapsedMs: elapsed,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/* ── LiveTerminal ────────────────────────────────────────────── */

function LiveTerminal({ liveUrl }: { liveUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      theme: { background: "#0d1117", foreground: "#e0e0e0" },
      fontSize: 13,
      fontFamily: "Fira Code, JetBrains Mono, Menlo, monospace",
      disableStdin: true,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    let writeQueue: string[] = [];
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      if (writeQueue.length === 0) return;
      term.write(writeQueue.join(""));
      writeQueue = [];
    };

    const es = new EventSource(liveUrl);
    es.onmessage = (e) => {
      try {
        let chunk = JSON.parse(e.data) as string;
        chunk = chunk.replace(/\r?\n/g, "\r\n");
        writeQueue.push(chunk);
        if (!rafId) rafId = requestAnimationFrame(flush);
      } catch { /* ignore */ }
    };
    es.onerror = () => es.close();

    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      es.close();
      term.dispose();
    };
  }, [liveUrl]);

  return <div ref={containerRef} className="h-full w-full" />;
}

/* ── Stage Detail Panel (right side) ─────────────────────────── */

function StagePanel({ stage, taskId, health, task }: {
  stage: Stage;
  taskId: string;
  health: HealthInfo;
  task: Task;
}) {
  const liveUrl = `/api/tasks/${taskId}/stages/${stage.id}/live`;
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const nav = useNavigate();

  const statusColors: Record<string, string> = {
    complete: "bg-rc-success/20 text-rc-success",
    running: "bg-rc-accent/20 text-rc-accent",
    failed: "bg-rc-error/20 text-rc-error",
    pending: "bg-rc-muted/20 text-rc-muted",
    skipped: "bg-rc-muted/20 text-rc-muted",
  };

  // Find gate verdict if this is a gate stage
  const isGate = stage.isGate
    || task.dispatchedStages?.find((s) => s.id === stage.id)?.is_gate
    || task.plan?.find((s) => s.id === stage.id)?.is_gate;

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-rc-text">{stage.id}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-input bg-rc-card text-rc-text-secondary font-mono">{stage.role}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-input ${statusColors[stage.status] ?? ""}`}>{stage.status}</span>
          {stage.status === "complete" && (
            <button onClick={() => nav(`/task/${taskId}/stage/${stage.id}`)} className="text-[10px] text-rc-accent hover:underline ml-auto">
              View detail →
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-rc-text-secondary flex-wrap">
          {stage.status === "running" && (
            <span className="font-mono">⏱ {fmtDuration(health.elapsedMs)}</span>
          )}
          {stage.duration_ms && stage.status !== "running" && (
            <span className="font-mono">{fmtDuration(stage.duration_ms)}</span>
          )}
          {health.slow && <span className="text-rc-warning font-semibold">⚠️ Slow</span>}
          {health.timeoutSoon && <span className="text-orange-400 font-semibold">⏱ Timeout soon</span>}
          {stage.retries > 0 && (
            <span className="font-mono">🔄 Attempt {stage.retries + 1}</span>
          )}
          {isGate && stage.status === "complete" && (
            <span className="font-mono text-rc-success">Gate ✓</span>
          )}
        </div>
      </div>

      {/* Rerun buttons for failed or stalled stages */}
      {(stage.status === "failed" || (stage.status === "running" && health.stalled)) && (
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={() => rerunFromHere(taskId, stage.id).catch(() => {})}
            className="px-3 py-1.5 bg-rc-accent/20 hover:bg-rc-accent/30 text-rc-accent text-xs rounded-btn transition"
          >
            ▶ Rerun from here
          </button>
          {isGate && (
            <button
              onClick={() => reevalGate(taskId, stage.id).catch(() => {})}
              className="px-3 py-1.5 bg-rc-warning/20 hover:bg-rc-warning/30 text-rc-warning text-xs rounded-btn transition"
            >
              ▶ Re-evaluate gate
            </button>
          )}
        </div>
      )}

      {/* Live terminal */}
      <div className="flex-1 min-h-0 glass-panel rounded-card overflow-hidden">
        {stage.status === "running" || stage.status === "complete" ? (
          <LiveTerminal key={liveUrl} liveUrl={liveUrl} />
        ) : (
          <div className="h-full bg-rc-code flex items-center justify-center font-mono text-xs text-rc-muted">
            Waiting for activity...
          </div>
        )}
      </div>

      {/* Artifacts */}
      {(stage.artifacts ?? []).length > 0 && (
        <div className="shrink-0 glass-panel rounded-card">
          <button onClick={() => setArtifactsOpen(!artifactsOpen)} className="w-full text-left px-3 py-2 flex items-center gap-2">
            <span className="text-xs font-bold text-rc-muted uppercase tracking-wider">{artifactsOpen ? "▾" : "▸"} Artifacts</span>
            <span className="text-[10px] font-mono bg-rc-accent/20 text-rc-accent px-1.5 py-0.5 rounded">{(stage.artifacts ?? []).length}</span>
          </button>
          {artifactsOpen && (
            <div className="px-3 pb-2 max-h-32 overflow-auto flex flex-wrap gap-1">
              {(stage.artifacts ?? []).map((a) => (
                <span key={a} className="text-[10px] font-mono text-rc-accent bg-rc-code px-1.5 py-0.5 rounded-input">{a}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Run Summary Panel (no stage selected) ───────────────────── */

function RunSummary({ task }: { task: Task }) {
  const completed = task.stages.filter((s) => s.status === "complete").length;
  const running = task.stages.filter((s) => s.status === "running").length;
  const failed = task.stages.filter((s) => s.status === "failed").length;
  const total = task.stages.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      <h3 className="text-sm font-semibold text-rc-text">Run Summary</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="glass-panel rounded-card p-3 text-center">
          <div className="text-2xl font-bold text-rc-accent">{pct}%</div>
          <div className="text-[10px] text-rc-muted uppercase">Progress</div>
        </div>
        <div className="glass-panel rounded-card p-3 text-center">
          <div className="text-2xl font-bold text-rc-text font-mono">{task.tokens.toLocaleString()}</div>
          <div className="text-[10px] text-rc-muted uppercase">Tokens</div>
        </div>
        <div className="glass-panel rounded-card p-3 text-center">
          <div className="text-2xl font-bold text-rc-text font-mono">{fmtDuration(task.elapsed_ms)}</div>
          <div className="text-[10px] text-rc-muted uppercase">Elapsed</div>
        </div>
        <div className="glass-panel rounded-card p-3 text-center">
          <div className="text-lg font-bold">
            <span className="text-rc-success">{completed}</span>
            {running > 0 && <span className="text-rc-accent"> / {running}🔄</span>}
            {failed > 0 && <span className="text-rc-error"> / {failed}❌</span>}
            <span className="text-rc-muted"> / {total}</span>
          </div>
          <div className="text-[10px] text-rc-muted uppercase">Stages</div>
        </div>
      </div>
      {/* Recent events */}
      <div className="flex-1 min-h-0 overflow-auto">
        <h4 className="text-xs font-bold text-rc-muted uppercase tracking-wider mb-2">Recent Events</h4>
        <div className="space-y-1">
          {task.stages
            .filter((s) => s.status !== "pending")
            .sort((a, b) => {
              const at = a.startedAt ? Date.parse(a.startedAt) : 0;
              const bt = b.startedAt ? Date.parse(b.startedAt) : 0;
              return bt - at;
            })
            .slice(0, 10)
            .map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs text-rc-text-secondary">
                <span className={s.status === "complete" ? "text-rc-success" : s.status === "running" ? "text-rc-accent" : s.status === "failed" ? "text-rc-error" : ""}>
                  {s.status === "complete" ? "✅" : s.status === "running" ? "●" : s.status === "failed" ? "❌" : "○"}
                </span>
                <span className="font-mono">{s.id}</span>
                <span className="text-rc-muted">({s.role})</span>
                {s.duration_ms && <span className="font-mono ml-auto">{fmtDuration(s.duration_ms)}</span>}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ── DAG Pipeline Node with health indicators ────────────────── */

function DagNode({ stage, health, selected, onClick }: {
  stage: Stage;
  health: HealthInfo;
  selected: boolean;
  onClick: () => void;
}) {
  const warningBorder = health.slow ? "ring-2 ring-rc-warning" : health.timeoutSoon ? "ring-2 ring-orange-400" : "";
  const selectedBorder = selected ? "ring-2 ring-rc-accent" : "";

  return (
    <div onClick={onClick} className={`${warningBorder} ${selectedBorder} rounded-card`}>
      <PipelineNode node={stage} onClick={onClick} />
    </div>
  );
}

/* ── Main LiveMonitor ────────────────────────────────────────── */

export default function LiveMonitor() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const task = tasks.find((t) => t.id === id);

  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [replanning, setReplanning] = useState(false);
  const prevIterRef = useRef<number>(0);

  // Polling
  useEffect(() => {
    if (!id) return;
    const poll = setInterval(() => { fetchTask(id).catch(() => {}); }, 3000);
    return () => clearInterval(poll);
  }, [id]);

  // Redirect pending tasks to discussion
  useEffect(() => {
    if (!task || !id) return;
    if (task.status === "pending") {
      nav(`/task/${id}/discuss`, { replace: true });
    }
  }, [task?.status, id, nav]);

  // Redirect to plan review
  useEffect(() => {
    if (!task || !id) return;
    if (task.status === "awaiting_approval") {
      nav(`/task/${id}/plan`, { replace: true });
    }
  }, [task?.status, id, nav]);

  // Re-plan animation
  useEffect(() => {
    if (!task) return;
    if (prevIterRef.current && task.currentIteration > prevIterRef.current) {
      setReplanning(true);
      const t = setTimeout(() => setReplanning(false), 3000);
      return () => clearTimeout(t);
    }
    prevIterRef.current = task.currentIteration;
  }, [task?.currentIteration]);

  // Auto-select first running stage
  useEffect(() => {
    if (!task) return;
    if (selectedStageId && task.stages.find((s) => s.id === selectedStageId)) return;
    const running = task.stages.find((s) => s.status === "running");
    if (running) setSelectedStageId(running.id);
  }, [task, selectedStageId]);

  // Compute DAG rows
  const depthRows = useMemo(() => {
    if (!task) return [];
    const depths = computeDepths(task.stages);
    const maxDepth = Math.max(0, ...depths.values());
    const rows: Stage[][] = [];
    for (let d = 0; d <= maxDepth; d++) {
      rows.push(task.stages.filter((s) => depths.get(s.id) === d));
    }
    return rows;
  }, [task]);

  // Health info
  const avg = useMemo(() => task ? avgDuration(task.stages) : 0, [task]);
  const healthMap = useMemo(() => {
    const m = new Map<string, HealthInfo>();
    if (!task) return m;
    for (const s of task.stages) m.set(s.id, getStageHealth(s, avg));
    return m;
  }, [task, avg]);

  // Re-compute health for running stages every second
  const [, setTick] = useState(0);
  useEffect(() => {
    const hasRunning = task?.stages.some((s) => s.status === "running");
    if (!hasRunning) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [task]);

  if (!task) return <div className="text-rc-muted">Task not found</div>;

  const isRunning = task.status === "running";
  const isPending = task.status === "pending";
  const selectedStage = selectedStageId ? task.stages.find((s) => s.id === selectedStageId) : undefined;
  const totalTokens = task.tokens;
  const filesModified = task.stages.flatMap((s) => s.artifacts ?? []).length;

  /* ── DAG column ──────────────────────────────────────────── */
  const dagColumn = (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold text-rc-text truncate">{task.name}</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-rc-text-secondary font-mono">{totalTokens.toLocaleString()} tok</span>
          <span className="text-xs text-rc-text-secondary">{filesModified} files</span>
          <span className="text-xs text-rc-text-secondary">{task.stages.length} stages</span>
          {isRunning && (
            <button onClick={async () => { await cancelTask(id!); nav("/"); }} className="px-3 py-1.5 bg-rc-error/20 hover:bg-rc-error/30 text-rc-error text-sm rounded-btn transition">Stop</button>
          )}
        </div>
      </div>

      {(isPending || (isRunning && task.stages.length === 0)) && (
        <div className="glass-panel rounded-card p-4 border border-rc-accent/30 shrink-0">
          <div className="flex items-center gap-3">
            <svg className="animate-spin h-5 w-5 text-rc-accent" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-rc-accent">Planner is analyzing task_brief.md…</span>
          </div>
        </div>
      )}

      {replanning && (
        <div className="glass-panel rounded-card p-3 border border-rc-accent/30 text-sm text-rc-accent animate-pulse shrink-0">
          🔄 Re-planning…
        </div>
      )}

      {/* DAG */}
      <div className="flex-1 min-h-0 overflow-auto space-y-3">
        {depthRows.map((row, depth) => (
          <div key={depth} className="flex flex-wrap gap-3 justify-center">
            {row.map((s) => (
              <div key={s.id} className="min-w-[180px] max-w-[240px] flex-1 stage-enter">
                <DagNode
                  stage={s}
                  health={healthMap.get(s.id) ?? { elapsedMs: 0 }}
                  selected={selectedStageId === s.id}
                  onClick={() => setSelectedStageId(s.id)}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  /* ── Detail column ───────────────────────────────────────── */
  const detailColumn = selectedStage ? (
    <StagePanel stage={selectedStage} taskId={id!} health={healthMap.get(selectedStage.id) ?? { elapsedMs: 0 }} task={task} />
  ) : (
    <RunSummary task={task} />
  );

  /* ── Wide layout (>1200px): side-by-side ─────────────────── */
  /* ── Narrow layout: vertical with inline expand ──────────── */
  return (
    <div className="flex flex-col h-full lg-wide:flex-row lg-wide:gap-4">
      {/* DAG side */}
      <div className="lg-wide:w-[40%] lg-wide:min-w-[350px] lg-wide:h-full h-auto max-h-[50vh] lg-wide:max-h-none flex flex-col">
        {dagColumn}
      </div>
      {/* Detail side */}
      <div className="lg-wide:flex-1 lg-wide:h-full flex-1 min-h-[300px] lg-wide:min-h-0 mt-4 lg-wide:mt-0 flex flex-col">
        {detailColumn}
      </div>
    </div>
  );
}
