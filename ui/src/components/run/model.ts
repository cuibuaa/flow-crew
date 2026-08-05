import type { RunDetailData, RunEvent, RunStage, RunStageAttempt } from "../../types";

export const NON_TERMINAL_RUN_STATUSES = [
  "pending",
  "running",
  "parked",
  "awaiting_approval",
] as const;

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

const SUCCESSFUL_RUN_STATUSES = new Set<string>(["complete", "shipped", "ceiling_hit"]);
const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

const STATUS_DESCRIPTIONS: Record<string, string> = {
  pending: "Registered and waiting to start.",
  running: "Workers are executing this run.",
  parked: "No worker is active; the run is waiting for an operator decision.",
  awaiting_approval: "The legacy plan approval is waiting; no stage is executing.",
  complete: "The engineering stage graph completed.",
  failed: "Execution ended after a stage or run failure.",
  shipped: "Research or declared delivery was confirmed by its gate.",
  ceiling_hit: "The search reached an honest ceiling without a better result.",
  escalated: "The run ended by escalating an issue for operator intervention.",
  reality_gate_failed: "A deterministic Reality Gate rejected the success claim.",
  phase_complete: "This phase ended as a non-success outcome; inspect its artifact and program ledger before advancing.",
  stopped: "The run was stopped by an operator or the system.",
  incomplete: "The budget ended while useful work was still in progress.",
};

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

export function isSuccessfulRunStatus(status: string): boolean {
  return SUCCESSFUL_RUN_STATUSES.has(status);
}

export function runStatusDescription(status: string): string {
  return STATUS_DESCRIPTIONS[status] ?? "This lifecycle status is unknown to this dashboard build.";
}

export function runStatusTone(status: string): "success" | "error" | "warning" | "active" | "neutral" {
  if (SUCCESSFUL_RUN_STATUSES.has(status)) return "success";
  if (["failed", "reality_gate_failed", "incomplete", "escalated"].includes(status)) return "error";
  if (["parked", "awaiting_approval", "stopped", "ceiling_hit"].includes(status)) return "warning";
  if (status === "running") return "active";
  return "neutral";
}

export function realRunStages(stages: RunStage[] | null | undefined): RunStage[] {
  return Array.isArray(stages) ? stages.filter((stage) => stage?.id && stage.id !== "_supervisor") : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsedTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  const safeMs = Math.max(0, ms);
  if (safeMs < 1_000) return `${Math.round(safeMs)}ms`;
  if (safeMs < 60_000) return `${(safeMs / 1_000).toFixed(1)}s`;
  if (safeMs < 3_600_000) return `${(safeMs / 60_000).toFixed(1)}m`;
  return `${(safeMs / 3_600_000).toFixed(1)}h`;
}

export function runElapsedMs(run: RunDetailData, nowMs = Date.now()): number | null {
  const start = parsedTimestamp(run.startedAt);
  const end = isTerminalRunStatus(run.status) ? parsedTimestamp(run.completedAt) : finiteNumber(nowMs);
  if (start != null && end != null) return Math.max(0, end - start);
  const durationMinutes = finiteNumber(run.duration_min);
  return durationMinutes == null ? null : Math.max(0, durationMinutes * 60_000);
}

function attemptDuration(attempt: RunStageAttempt, nowMs: number): number | null {
  if (attempt.status === "running") {
    const started = parsedTimestamp(attempt.startedAt);
    return started != null && Number.isFinite(nowMs) ? Math.max(0, nowMs - started) : null;
  }
  const recorded = finiteNumber(attempt.duration_ms);
  if (recorded != null) return Math.max(0, recorded);
  const started = parsedTimestamp(attempt.startedAt);
  const ended = parsedTimestamp(attempt.completedAt);
  return started != null && ended != null ? Math.max(0, ended - started) : null;
}

export interface StageAttemptRow {
  key: string;
  index: number;
  status: string;
  durationMs: number | null;
  error?: string;
  current: boolean;
  recorded: boolean;
}

export interface StageAttemptLedger {
  rows: StageAttemptRow[];
  recordedAttempts: number;
  executions: number;
  reruns: number;
  failedAttempts: number;
  failedAttemptsExact: boolean;
  current: boolean;
  legacyAggregate: boolean;
  aggregateDurationMs: number | null;
}

function stageHasExecution(stage: RunStage): boolean {
  return ["running", "complete", "completed", "failed"].includes(stage.status)
    || (finiteNumber(stage.reruns) ?? 0) > 0
    || (Array.isArray(stage.attempts) && stage.attempts.length > 0);
}

export function stageAttemptLedger(stage: RunStage, nowMs = Date.now()): StageAttemptLedger {
  const attempts = Array.isArray(stage.attempts) ? stage.attempts.filter(Boolean) : [];
  const rows: StageAttemptRow[] = attempts.map((attempt, position) => ({
    key: `recorded-${attempt.index ?? position + 1}-${position}`,
    index: finiteNumber(attempt.index) ?? position + 1,
    status: attempt.status || "unknown",
    durationMs: attemptDuration(attempt, nowMs),
    error: typeof attempt.error === "string" && attempt.error.trim() ? attempt.error : undefined,
    current: attempt.status === "running",
    recorded: true,
  }));
  const hasRecordedCurrent = rows.some((row) => row.current);
  const hasCurrent = stage.status === "running";
  if (hasCurrent && !hasRecordedCurrent) {
    const nextIndex = rows.reduce((max, row) => Math.max(max, row.index), 0) + 1;
    rows.push({
      key: "unrecorded-current",
      index: nextIndex,
      status: "running",
      durationMs: null,
      current: true,
      recorded: false,
    });
  }

  const legacyAggregate = rows.length === 0 && stageHasExecution(stage);
  const inferredExecutions = legacyAggregate
    ? Math.max(1, (finiteNumber(stage.reruns) ?? 0) + 1)
    : rows.length;
  const executions = Math.max(inferredExecutions, hasCurrent ? attempts.length + (hasRecordedCurrent ? 0 : 1) : 0);
  const legacyFailed = attempts.length === 0 && stage.status === "failed";
  return {
    rows,
    recordedAttempts: attempts.filter((attempt) => attempt.status !== "running").length,
    executions,
    reruns: Math.max(0, finiteNumber(stage.reruns) ?? 0, executions - 1),
    failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length
      + (legacyFailed ? 1 : 0),
    failedAttemptsExact: !legacyFailed,
    current: hasCurrent,
    legacyAggregate,
    aggregateDurationMs: finiteNumber(stage.duration_ms),
  };
}

export interface FailureHistory {
  failedAttempts: number;
  failedAttemptsExact: boolean;
  stageIds: string[];
  failedStageIds: string[];
  failedGateIds: string[];
}

export function runFailureHistory(stages: RunStage[]): FailureHistory {
  const realStages = realRunStages(stages);
  let failedAttempts = 0;
  let failedAttemptsExact = true;
  const stageIds: string[] = [];
  const failedStageIds: string[] = [];
  const failedGateIds: string[] = [];
  for (const stage of realStages) {
    const ledger = stageAttemptLedger(stage, 0);
    if (ledger.failedAttempts > 0) {
      failedAttempts += ledger.failedAttempts;
      stageIds.push(stage.id);
    }
    if (!ledger.failedAttemptsExact) failedAttemptsExact = false;
    if (stage.status === "failed") failedStageIds.push(stage.id);
    if (stage.is_gate && stage.status === "failed") failedGateIds.push(stage.id);
  }
  return { failedAttempts, failedAttemptsExact, stageIds, failedStageIds, failedGateIds };
}

interface UsageSlice {
  value: number;
  complete: boolean;
}

function tokenPair(record: { tokens_in?: number; tokens_out?: number }): UsageSlice {
  const input = finiteNumber(record.tokens_in);
  const output = finiteNumber(record.tokens_out);
  return {
    value: Math.max(0, input ?? 0) + Math.max(0, output ?? 0),
    complete: input != null && output != null,
  };
}

function stageUsage(stage: RunStage): UsageSlice {
  if (!stageHasExecution(stage)) return { value: 0, complete: true };
  const aggregate = tokenPair(stage);
  if (aggregate.complete) return aggregate;
  const attempts = Array.isArray(stage.attempts) ? stage.attempts.filter(Boolean) : [];
  if (attempts.length > 0) {
    const slices = attempts.map(tokenPair);
    if (slices.every((slice) => slice.complete)) {
      return { value: slices.reduce((sum, slice) => sum + slice.value, 0), complete: true };
    }
    if (aggregate.value === 0) {
      return { value: slices.reduce((sum, slice) => sum + slice.value, 0), complete: false };
    }
  }
  return aggregate;
}

export interface RunUsageTotal {
  tokens: number;
  complete: boolean;
  notes: string[];
}

export function runUsageTotal(run: RunDetailData): RunUsageTotal {
  const stages = realRunStages(run.stages);
  const executedStages = stages.filter(stageHasExecution);
  let tokens = 0;
  let complete = true;
  const notes: string[] = [];

  for (const stage of executedStages) {
    const usage = stageUsage(stage);
    tokens += usage.value;
    if (!usage.complete) {
      complete = false;
      notes.push(`usage for ${stage.id} is incomplete`);
    }
  }

  if (run.supervisor) {
    const supervisor = tokenPair(run.supervisor);
    tokens += supervisor.value;
    if (!supervisor.complete || run.supervisor.status === "running") {
      complete = false;
      notes.push("supervisor usage is not settled");
    }
  } else {
    complete = false;
    notes.push("supervisor usage is unavailable");
  }

  if (!isTerminalRunStatus(run.status)) {
    complete = false;
    notes.push("the run is still open");
  }
  return { tokens, complete, notes: [...new Set(notes)] };
}

export type SummarySectionKind = "conclusion" | "delivery" | "attention" | "audit";

export interface ParsedSummarySection {
  heading: string;
  lines: string[];
  kind: SummarySectionKind;
}

export type ParsedRunSummary =
  | { kind: "terminal"; title: "Run Summary" | "Research Summary"; sections: ParsedSummarySection[]; raw: string }
  | { kind: "progress"; raw: string };

function summarySectionKind(heading: string): SummarySectionKind {
  const normalized = heading.trim().toLowerCase();
  if (/^(outcome|what was done|what was tried\s*&\s*learned|key decisions)$/.test(normalized)) return "conclusion";
  if (/^files changed(?:\s*\(|$)/.test(normalized)) return "delivery";
  if (/^(risks?\s*\/\s*notes|next steps|reality-gate advisories|orchestration notes)$/.test(normalized)) return "attention";
  return "audit";
}

export function parseRunSummary(content: string): ParsedRunSummary {
  const raw = typeof content === "string" ? content : "";
  const normalized = raw.replace(/^\uFEFF/, "").trimStart();
  const titleMatch = normalized.match(/^# (Run Summary|Research Summary)\s*(?:\r?\n|$)/);
  if (!titleMatch) return { kind: "progress", raw };
  const title = titleMatch[1] as "Run Summary" | "Research Summary";
  const body = normalized.slice(titleMatch[0].length);
  const matches = [...body.matchAll(/^##\s+(.+)\s*$/gm)];
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    const heading = match[1].trim();
    const lines = body.slice(start, end).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { heading, lines, kind: summarySectionKind(heading) };
  });
  return { kind: "terminal", title, sections, raw };
}

export interface HumanRunEvent {
  key: string;
  timestamp: string;
  description: string;
  context: string;
  kind: "complete" | "error" | "guide" | "warning" | "neutral";
}

const MAINTENANCE_EVENTS = new Set(["attempt_summary_refresh_requested"]);

function eventContext(event: RunEvent): string {
  const rawStage = event.stage ?? event.stageId;
  const stage = typeof rawStage === "string" ? rawStage.trim() : "";
  const message = typeof event.message === "string" ? event.message.trim() : "";
  const detail = typeof event.detail === "string" ? event.detail.trim() : "";
  return [stage ? `Stage ${stage}` : "", message || detail].filter(Boolean).join(" · ");
}

export function humanizeRunEvents(events: RunEvent[] | null | undefined): HumanRunEvent[] {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event, index) => {
    if (!event || typeof event !== "object") return [];
    const timestamp = String(event.ts ?? event.timestamp ?? "").trim();
    if (!timestamp) return [];
    const type = String(event.event ?? event.type ?? "").trim();
    if (MAINTENANCE_EVENTS.has(type)) return [];
    const context = eventContext(event);
    const known: Record<string, [string, HumanRunEvent["kind"]]> = {
      stage_complete: ["Stage completed", "complete"],
      complete: ["Work completed", "complete"],
      stage_failed: ["Stage failed", "error"],
      stage_error: ["Stage reported an error", "error"],
      error: ["An execution error was recorded", "error"],
      stage_skipped: ["Stage was skipped", "neutral"],
      verdict_written: ["A gate verdict was recorded", "guide"],
      attempt_results_updated: ["Attempt results were updated", "neutral"],
      iteration_completed: ["An iteration completed", "complete"],
      run_completed: ["The run reached its recorded outcome", "complete"],
      campaign_alert: ["The campaign raised an alert", "warning"],
      research_injected: ["New research guidance was added", "guide"],
      supervisor_replan: ["The supervisor changed the execution plan", "guide"],
      supervisor_reject: ["The supervisor requested another attempt", "warning"],
      supervisor_guide: ["The supervisor recorded guidance", "guide"],
      guide: ["Execution guidance was recorded", "guide"],
      plan_dispatch_retry: ["Plan dispatch was retried", "warning"],
      research_mode_degraded: ["Research mode continued with reduced evidence", "warning"],
      reality_gate_advisory: ["Reality Gate recorded an advisory", "warning"],
      parallel_scope_serialized: ["Parallel work was serialized to protect scope", "warning"],
      parallel_write_conflict: ["Parallel stages reported a write conflict", "error"],
      approval_parked: ["The run paused for operator approval", "warning"],
      approval_resolved: ["The approval was resolved", "complete"],
    };
    const [description, kind] = known[type] ?? ["Run activity was recorded", "neutral"];
    return [{ key: `${timestamp}-${index}`, timestamp, description, context, kind }];
  });
}
