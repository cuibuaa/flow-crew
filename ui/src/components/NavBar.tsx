import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRefreshTasks, useTasks } from "./Layout";
import TaskSettingsPanel from "./TaskSettingsPanel";
import NewTaskDialog from "./NewTaskDialog";
import { createTask, updateTask } from "../api";
import type { CampaignTriggers } from "../types";

export default function NavBar() {
  const nav = useNavigate();
  const location = useLocation();
  const tasks = useTasks();
  const refreshTasks = useRefreshTasks();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const match = location.pathname.match(/\/task\/([^/]+)/);
  const selectedId = match?.[1];
  const task = selectedId ? tasks.find(t => t.id === selectedId) : undefined;

  const [newTaskError, setNewTaskError] = useState<string | null>(null);

  const handleSaveSettings = async (vals: { timeoutMs: number; maxIterations: number; maxRetries: number; autoApproveRetries: boolean; campaignTriggers?: CampaignTriggers }) => {
    if (!selectedId) return;
    try {
      await updateTask(selectedId, vals);
      refreshTasks();
    } catch (err) {
      setNewTaskError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewTask = async (name: string, campaignId?: string, campaignName?: string) => {
    setNewTaskOpen(false);
    setNewTaskError(null);
    try {
      const { id } = await createTask({ name, workflow: "default", discussion: [], plan: [], campaignId, campaignName });
      nav(`/task/${id}/discuss`);
    } catch (err) {
      setNewTaskError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <header className="h-14 bg-rc-bg border-b border-rc-border flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center space-x-3 cursor-pointer" onClick={() => nav("/")}>
          <div className="w-8 h-8 rounded-btn bg-gradient-to-br from-[#667eea] to-[#764ba2] flex items-center justify-center shadow-glow">
            <img src="/favicon.svg" alt="FlowCrew" className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-[#667eea] to-[#e0e0e0]">
            flowcrew
          </h1>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={() => setNewTaskOpen(true)} className="btn-accent px-3 py-1.5 text-sm">+ New Task</button>
          <button onClick={() => nav("/")} className="btn-ghost px-3 py-1.5 text-sm">Home</button>
          <button onClick={() => nav("/agents")} className="btn-ghost px-3 py-1.5 text-sm">Agents</button>
          <button onClick={() => nav("/settings")} className="btn-ghost px-3 py-1.5 text-sm">Settings</button>
          {task && (
            <button onClick={() => setSettingsOpen(true)} className="btn-ghost px-3 py-1.5 text-sm" title="Task Settings">⚙️</button>
          )}
        </div>
      </header>
      {task && (
        <TaskSettingsPanel
          task={task}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      )}
      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onSubmit={handleNewTask}
      />
      {newTaskError && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-rc-error/90 text-white text-sm px-4 py-2 rounded-card shadow-xl cursor-pointer" onClick={() => setNewTaskError(null)}>
          {newTaskError}
        </div>
      )}
    </>
  );
}
