export function formatDuration(milliseconds: number | null, partial = false): string {
  if (milliseconds === null) return "Duration unknown";
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const value = minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return partial ? `At least ${value}` : value;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat().format(value);
}

export function statusClass(status: string): string {
  if (status === "running") return "running";
  if (status === "parked" || status === "awaiting_approval") return "parked";
  if (["failed", "reality_gate_failed", "incomplete", "stopped"].includes(status)) return "failed";
  if (["complete", "shipped", "ceiling_hit", "phase_complete"].includes(status)) return "successful";
  if (status === "escalated") return "warning";
  return "neutral";
}
