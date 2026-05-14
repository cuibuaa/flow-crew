import type { Task } from "../types";

export default function StatusBar({ tasks }: { tasks: Task[] }) {
  const running = tasks.filter((t) => t.status === "running").length;
  const awaiting = tasks.filter((t) => t.status === "awaiting_approval").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  return (
    <footer className="h-10 bg-rc-bg border-t border-rc-border flex items-center px-6 space-x-6 text-xs text-rc-text-secondary shrink-0">
      <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-rc-accent mr-1.5" />{running} running</span>
      {awaiting > 0 && <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-amber-400 mr-1.5" />{awaiting} awaiting</span>}
      <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-rc-success mr-1.5" />{completed} completed</span>
      {failed > 0 && <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-rc-error mr-1.5" />{failed} failed</span>}
    </footer>
  );
}
