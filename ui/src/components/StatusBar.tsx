import type { Task } from "../types";

export default function StatusBar({ tasks }: { tasks: Task[] }) {
  const running = tasks.filter((t) => t.status === "running").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const tokens = tasks.reduce((s, t) => s + t.tokens, 0);
  return (
    <footer className="h-10 bg-rc-bg border-t border-rc-border flex items-center px-6 space-x-6 text-xs text-rc-text-secondary shrink-0">
      <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-rc-accent mr-1.5" />{running} running</span>
      <span className="flex items-center"><span className="w-2 h-2 rounded-full bg-rc-success mr-1.5" />{completed} completed</span>
      <span className="font-mono">{tokens.toLocaleString()} tokens today</span>
    </footer>
  );
}
