import type { RunStatus } from "../components/campaign/types";

export const NON_TERMINAL_RUN_STATUSES = ["pending", "running", "parked", "awaiting_approval"] as const;
export const TERMINAL_RUN_STATUSES = [
  "complete",
  "failed",
  "shipped",
  "ceiling_hit",
  "escalated",
  "reality_gate_failed",
  "phase_complete",
  "stopped",
  "incomplete",
] as const;

const RUN_STATUS_SET = new Set<string>([...NON_TERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);
const SUCCESSFUL_RUN_STATUS_SET = new Set<string>(["complete", "shipped", "ceiling_hit"]);

export function isRunStatus(status: string): status is RunStatus {
  return RUN_STATUS_SET.has(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

export function isSuccessfulRunStatus(status: string): boolean {
  return SUCCESSFUL_RUN_STATUS_SET.has(status);
}
