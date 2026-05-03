import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getCampaignDisplayName, getCampaignIteration } from "../types";
import type { PlanStage } from "../types";
import { executeTask, fetchDispatch, approveDispatch, fetchIterationLog } from "../api";
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
  const campaignIteration = task ? getCampaignIteration(task) : 1;
  const showIterationSummary = Boolean(task && task.currentIteration > 1 && iterationLog);

  const [waitingForPlan, setWaitingForPlan] = useState(false);

  useEffect(() => {
    if (!id || !task || task.currentIteration <= 1) return;
    fetchIterationLog(id).then(setIterationLog);
  }, [id, task?.currentIteration]);

  // Track whether we arrived here while planner is still running
  useEffect(() => {
    if (!task) return;
    if (task.status === "running" && !isAwaiting) {
      setWaitingForPlan(true);
    } else if (isAwaiting || task.status === "completed" || task.status === "failed") {
      setWaitingForPlan(false);
    }
  }, [task?.status, isAwaiting]);

  // Redirect to the appropriate view based on task status
  useEffect(() => {
    if (!task || !id) return;
    if (task.status === "pending") {
      nav(`/task/${id}/discuss`, { replace: true });
      return;
    }
    if (task.status === "completed" || task.status === "failed") {
      nav(`/task/${id}/monitor`, { replace: true });
      return;
    }
    // When running: stay on plan review if waitingForPlan, otherwise redirect
    if (task.status === "running" && !waitingForPlan && !isAwaiting) {
      const hasDispatched = task.stages.some(s => s.dispatched);
      if (hasDispatched) {
        nav(`/task/${id}/monitor`, { replace: true });
      }
    }
  }, [task?.status, id, nav, waitingForPlan, isAwaiting]);

  useEffect(() => {
    if (!id) return;
    // Poll for dispatch while awaiting approval OR while waiting for planner to finish
    if (!isAwaiting && !waitingForPlan) return;
    const poll = () => {
      fetchDispatch(id).then((d) => setDispatchedStages(d.stages)).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [isAwaiting, waitingForPlan, id]);

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
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-rc-text">Plan Review</h2>
          {task && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-rc-text-secondary">
              {task.campaignId && (
                <span className="rounded-input bg-rc-card px-2 py-0.5 font-mono">
                  {getCampaignDisplayName(task)} #{task.campaignSeq ?? "?"}
                </span>
              )}
              {task.campaignId ? (
                <span className="rounded-input border border-rc-border px-2 py-0.5 font-mono">
                  Campaign iteration {campaignIteration}
                </span>
              ) : (
                task.currentIteration > 1 && <span className="rounded-input border border-rc-border px-2 py-0.5 font-mono">Run iteration {task.currentIteration}</span>
              )}
              <span className="font-mono">Max {task.maxIterations} iterations</span>
            </div>
          )}
        </div>
      </div>
      {error && <div className="text-rc-error text-sm mb-3">{error}</div>}

      {task?.researchInjection && (
        <div className="mb-4 rounded-card border border-amber-300/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <div className="font-semibold">Research injected for this plan review</div>
          <div className="mt-1 text-xs text-amber-100/90">
            Campaign iteration {task.researchInjection.iteration}: {task.researchInjection.message}
          </div>
        </div>
      )}

      {showIterationSummary && (
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
      {waitingForPlan && !isAwaiting && !dispatchedStages.length && (
        <div className="mt-6 text-rc-muted text-sm animate-pulse">Planner is analyzing the task and creating an execution plan…</div>
      )}
    </div>
  );
}
