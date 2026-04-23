import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createTask, discussWsUrl, executeTask } from "../api";
import { useTasks } from "./Layout";
import Terminal, { type TerminalHandle } from "./Terminal";

export default function TaskDiscussion() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const task = tasks.find((t) => t.id === id);
  const [taskId, setTaskId] = useState(id);
  const [generating, setGenerating] = useState(false);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showMonitorLink, setShowMonitorLink] = useState(false);
  const termRef = useRef<TerminalHandle>(null);
  const createdRef = useRef(false);

  const taskRunning = task && task.status !== 'pending';

  // Bug 2: Auto-create task on mount when taskId === "new"
  useEffect(() => {
    if (taskId !== "new" || createdRef.current) return;
    createdRef.current = true;
    setCreating(true);
    createTask({ name: "New Discussion", workflow: "default", discussion: [], plan: [] })
      .then(({ id: newId }) => {
        setTaskId(newId);
        nav(`/task/${newId}/discuss`, { replace: true });
      })
      .catch(() => {})
      .finally(() => setCreating(false));
  }, [taskId, nav]);

  const handleReady = () => setConnected(true);

  // Bug 3: Navigate to monitor instead of plan
  const handlePlanReady = () => {
    setGenerating(false);
    if (taskId && taskId !== "new") {
      executeTask(taskId).catch(() => {});
    }
    nav(`/task/${taskId}/monitor`);
  };

  // Bug 4: Keep terminal alive during generate plan — just send the command
  const handleGeneratePlan = () => {
    if (!termRef.current) return;
    setGenerating(true);
    setShowMonitorLink(false);
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
            className="h-full w-full rounded-card overflow-hidden bg-rc-code border border-rc-border shadow-glow"
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            {creating ? (
              <div className="flex items-center gap-3 text-rc-text-secondary">
                <svg className="animate-spin h-5 w-5 text-rc-accent" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm">Creating task…</span>
              </div>
            ) : (
              <span className="text-rc-muted text-sm">Initializing…</span>
            )}
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
