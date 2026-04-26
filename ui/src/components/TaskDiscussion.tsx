import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { discussWsUrl, executeTask } from "../api";
import { useTasks } from "./Layout";
import Terminal, { type TerminalHandle } from "./Terminal";

export default function TaskDiscussion() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const task = tasks.find((t) => t.id === id);
  const taskId = id;
  const [generating, setGenerating] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showMonitorLink, setShowMonitorLink] = useState(false);
  const [briefGuidance, setBriefGuidance] = useState<string | null>(null);
  const termRef = useRef<TerminalHandle>(null);

  const taskRunning = task && task.status !== 'pending';

  const handleReady = () => setConnected(true);

  const handlePlanReady = () => {
    setGenerating(false);
    setBriefGuidance(null);
    if (taskId && taskId !== "new") {
      executeTask(taskId).catch(() => {});
    }
    nav(`/task/${taskId}/monitor`);
  };

  const handleBriefNotReady = (message?: string) => {
    setGenerating(false);
    setShowMonitorLink(false);
    setBriefGuidance(message ?? "Confirm the final task brief in Discussion before generating a plan.");
  };

  const handleGeneratePlan = () => {
    if (!termRef.current) return;
    setGenerating(true);
    setShowMonitorLink(false);
    setBriefGuidance(null);
    setTimeout(() => setShowMonitorLink(true), 15000);
    termRef.current.sendJson({ type: "generate_plan" });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Bug 1: mb-16 gives space for button bar */}
      <div className="flex-1 min-h-0 mb-16">
        {taskId && taskId !== "new" ? (
          <Terminal
            ref={termRef}
            wsUrl={discussWsUrl(taskId)}
            interactive
            onReady={handleReady}
            onPlanReady={handlePlanReady}
            onBriefNotReady={handleBriefNotReady}
            className="h-full w-full rounded-card overflow-hidden bg-rc-code border border-rc-border shadow-glow"
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="glass-panel rounded-card p-6 max-w-md text-center space-y-3">
              <h2 className="text-sm font-semibold text-rc-text">Start a task from the campaign-aware flow</h2>
              <p className="text-sm text-rc-text-secondary">
                This direct route no longer auto-creates a standalone task because it bypasses campaign selection.
              </p>
              <button onClick={() => nav("/", { replace: true })} className="btn-accent px-4 py-2 text-sm">
                Return Home
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="fixed bottom-14 left-6 flex items-center space-x-3 py-3">
        {connected && !generating && !taskRunning && (
          <button
            onClick={handleGeneratePlan}
            className="btn-accent px-5 py-2.5 text-sm font-medium whitespace-nowrap"
          >
            Generate Plan →
          </button>
        )}
        {generating && (
          <span className="text-sm text-rc-text-secondary animate-pulse">Writing task_brief.md…</span>
        )}
        {!generating && briefGuidance && (
          <span className="max-w-xl text-sm text-amber-100">
            {briefGuidance}
          </span>
        )}
        {generating && showMonitorLink && (
          <button onClick={() => nav(`/task/${taskId}/monitor`)} className="text-sm text-rc-accent hover:underline">
            Taking a while? Go to Monitor →
          </button>
        )}
        {!generating && taskRunning && (
          <button onClick={() => nav(`/task/${taskId}/monitor`)} className="btn-accent px-5 py-2.5 text-sm font-medium">
            Go to Monitor →
          </button>
        )}
      </div>
    </div>
  );
}
