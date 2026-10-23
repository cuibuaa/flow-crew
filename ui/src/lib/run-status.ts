export const NON_TERMINAL_RUN_STATUSES = ["pending", "running", "parked"] as const;
export const TERMINAL_RUN_STATUSES = [
  "complete",
  "failed",
  "shipped",
  "ceiling_hit",
  "escalated",
  "reality_gate_failed",
  "cancelled",
  "incomplete",
] as const;

export type RunStatus = typeof NON_TERMINAL_RUN_STATUSES[number] | typeof TERMINAL_RUN_STATUSES[number];

const RUN_STATUS_SET = new Set<string>([...NON_TERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

export function isRunStatus(status: string): status is RunStatus {
  return RUN_STATUS_SET.has(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

export function isSuccessfulRunStatus(status: string): boolean {
  return runStatusTone(status) === "success";
}

const RUN_STATUS_TONES: Record<string, "success" | "error" | "warning" | "active" | "neutral"> = {
  pending: "neutral", running: "active", parked: "warning",
  complete: "success", shipped: "success", ceiling_hit: "success",
  failed: "error", reality_gate_failed: "error", incomplete: "error", escalated: "error",
  cancelled: "warning", needs_summary: "warning", rejected: "error",
};

export function runStatusTone(status: string): "success" | "error" | "warning" | "active" | "neutral" {
  return RUN_STATUS_TONES[status] ?? "neutral";
}
