import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import type { Task } from "../types";
import { fetchTasks } from "../api";
import NavBar from "./NavBar";
import StatusBar from "./StatusBar";

const TasksCtx = createContext<{ tasks: Task[]; refresh: () => void }>({ tasks: [], refresh: () => {} });
export const useTasks = () => useContext(TasksCtx).tasks;
export const useRefreshTasks = () => useContext(TasksCtx).refresh;

export default function Layout() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  const match = location.pathname.match(/\/task\/([^/]+)/);
  const selectedId = match?.[1];
  const isHome = location.pathname === "/";

  const load = useCallback(() => {
    fetchTasks()
      .then((t) => { setTasks(t); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading) return <div className="h-screen w-screen flex items-center justify-center bg-rc-bg text-rc-muted">Loading…</div>;
  if (error) return <div className="h-screen w-screen flex items-center justify-center bg-rc-bg text-rc-error">Error: {error}</div>;

  return (
    <TasksCtx.Provider value={{ tasks, refresh: load }}>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-rc-bg">
        <NavBar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet context={{ tasks }} />
        </main>
        <StatusBar tasks={tasks} />
      </div>
    </TasksCtx.Provider>
  );
}
