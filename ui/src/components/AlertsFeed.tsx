import type { Task } from "../types";

interface Alert {
  icon: string;
  message: string;
  time: string;
}

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function AlertsFeed({ tasks }: { tasks: Task[] }) {
  const alerts: Alert[] = [];
  const now = Date.now();

  for (const t of tasks) {
    for (const s of t.stages) {
      if (s.status === "running" && s.startedAt) {
        const elapsed = now - Date.parse(s.startedAt);
        if (elapsed > 600_000) {
          alerts.push({ icon: "⚠️", message: `${t.name}: ${s.id} running for ${Math.floor(elapsed / 60000)}m`, time: s.startedAt });
        }
      }
      if (s.status === "complete" && s.startedAt) {
        alerts.push({ icon: "🟢", message: `${t.name}: ${s.id} completed`, time: s.completedAt ?? s.startedAt });
      }
      if (s.status === "failed" && s.startedAt) {
        alerts.push({ icon: "🔴", message: `${t.name}: ${s.id} failed${s.error ? ` — ${s.error}` : ""}`, time: s.completedAt ?? s.startedAt });
      }
    }
  }

  alerts.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const recent = alerts.slice(0, 8);

  if (recent.length === 0) return null;

  return (
    <div className="space-y-1">
      {recent.map((a, i) => (
        <div key={i} className="flex items-center gap-2 text-xs text-rc-text-secondary">
          <span>{a.icon}</span>
          <span className="text-rc-muted font-mono">{timeAgo(a.time)}</span>
          <span className="truncate">{a.message}</span>
        </div>
      ))}
    </div>
  );
}
