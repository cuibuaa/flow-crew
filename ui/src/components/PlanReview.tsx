import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { PlanStage } from "../types";
import { executeTask, fetchTask, fetchDispatch, approveDispatch, fetchIterationLog } from "../api";
import { useTasks } from "./Layout";
import PipelineNode from "./PipelineNode";

const roleIcons: Record<string, string> = {
  coder: "💻", qa: "✅", paper_writer: "✍️", paper_reviewer: "📝",
  ai_detector: "🔎", researcher: "🔍", doc_writer: "✍️", doc_reviewer: "📝", planner: "📋",
};

export default function PlanReview() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const task = tasks.find((t) => t.id === id);

  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchedStages, setDispatchedStages] = useState<PlanStage[]>([]);
  const [approving, setApproving] = useState(false);
  const [iterationLog, setIterationLog] = useState<string | null>(null);
  const [iterLogOpen, setIterLogOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const isAwaiting = task?.status === "awaiting_approval";
  const plan = task?.plan ?? [];

  useEffect(() => {
    if (!id || !task || task.currentIteration <= 1) return;
    fetchIterationLog(id).then(setIterationLog);
  }, [id, task?.currentIteration]);

  // If task is still pending/running (planner working), redirect to monitor
  useEffect(() => {
    if (!task || !id) return;
    if (task.status === "pending" || task.status === "running") {
      nav(`/task/${id}/monitor`, { replace: true });
    }
  }, [task?.status, id, nav]);

  useEffect(() => {
    if (!isAwaiting || !id) return;
    const poll = () => {
      fetchDispatch(id).then((d) => setDispatchedStages(d.stages)).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [isAwaiting, id]);

  const handleApprove = async () => {
    if (!id) return;
    setApproving(true);
    try {
      await approveDispatch(id);
      nav(`/task/${id}/monitor`);
    } catch (e) {
      setError(String(e));
      setApproving(false);
    }
  };

  const handleExecute = async () => {
    if (!id) return;
    setExecuting(true);
    setError(null);
    try {
      await executeTask(id);
      nav(`/task/${id}/monitor`);
    } catch (e) {
      setError(String(e));
      setExecuting(false);
    }
  };

  const stages = isAwaiting && dispatchedStages.length > 0 ? dispatchedStages : plan;

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-rc-text">
          {task && task.currentIteration > 1
            ? `🔄 Plan Review — Iteration ${task.currentIteration} (retry)`
            : "Pipeline Stages"}
        </h2>
      </div>
      {error && <div className="text-rc-error text-sm mb-3">{error}</div>}

      {task && task.currentIteration > 1 && iterationLog && (
        <div className="mb-4 glass-panel rounded-card">
          <button onClick={() => setIterLogOpen(!iterLogOpen)} className="w-full text-left px-3 py-2 text-xs text-rc-text-secondary hover:text-rc-text">
            {iterLogOpen ? "▾" : "▸"} Previous Iteration Summary
          </button>
          {iterLogOpen && (
            <pre className="px-3 pb-2 text-xs font-mono text-rc-muted whitespace-pre-wrap max-h-40 overflow-auto">{iterationLog}</pre>
          )}
        </div>
      )}

      <div className="relative space-y-1">
        {stages.map((stage, i) => (
          <div key={stage.id} className={`relative ${i > 0 ? "ml-6 pl-4 tree-line" : "tree-root"} py-2`}>
            <div className={`relative z-10 ${isAwaiting && dispatchedStages.length > 0 ? "border border-dashed border-rc-warning/40 rounded-card" : ""}`}>
              <PipelineNode node={stage} />
              <div className="flex items-center gap-2 mt-1 ml-4">
                {roleIcons[stage.role] && (
                  <span className="text-xs" title={stage.role}>{roleIcons[stage.role]}</span>
                )}
                {stage.is_gate && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-rc-accent/20 text-rc-accent rounded font-bold">🔒 gate</span>
                )}
                {stage.retry_to && stage.retry_to.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-rc-warning/20 text-rc-warning rounded font-bold">
                    🔄 retry → [{stage.retry_to.join(", ")}]
                  </span>
                )}
              </div>
              {stage.retry_to && stage.retry_to.length > 0 && (
                <div className="ml-4 mt-1 text-[10px] text-rc-muted italic">(only if gate fails)</div>
              )}
            </div>
          </div>
        ))}
        {!stages.length && <div className="text-rc-muted text-sm">No plan yet. Waiting for dispatch…</div>}
      </div>

      {stages.some((s) => s.is_gate || (s.retry_to && s.retry_to.length > 0)) && (
        <div className="mt-4 glass-panel rounded-card p-2 text-xs text-rc-muted">
          ℹ️ If gates pass → done. If fail → fix/revise → re-check.
        </div>
      )}

      {isAwaiting && dispatchedStages.length > 0 && (
        <div className="flex space-x-2 mt-4">
          <button onClick={handleApprove} disabled={approving}
            className="btn-accent px-5 py-2.5 text-sm font-medium disabled:opacity-50">
            {approving ? "Approving…" : "✓ Approve & Execute"}
          </button>
          <button onClick={() => nav(`/task/${id}/discuss`)}
            className="btn-ghost px-4 py-2.5 text-sm border border-rc-border">
            ← Back to Discussion
          </button>
        </div>
      )}
      {isAwaiting && !dispatchedStages.length && (
        <div className="mt-6 text-rc-muted text-sm animate-pulse">Loading dispatched stages…</div>
      )}
    </div>
  );
}
