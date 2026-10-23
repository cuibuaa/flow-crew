import { atomicWrite } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendTextRecord } from './append-boundary.js';
import { readJsonlFile, readOptionalJsonlFile, type JsonlReadCursor } from './jsonl.js';
import type { AttemptDisposition, StageAttempt, StageStatus, StoreState } from './store.js';
import type { AdapterFailureKind } from './adapters/base.js';
import type { ProviderFailure } from './provider-result.js';
import { isSettledStageStatus, isTerminalRunStatus, requireExistingRunArtifactDirectory, requireRunArtifactDirectory, runDir, STAGE_STATUS } from './store.js';

export type RunEventType =
  | 'execution_notice'
  | 'stage_wrap_up_requested'
  | 'stage_wrap_up_delivered'
  | 'stage_wrap_up_completed'
  | 'stage_wrap_up_forced'
  | 'plan_revision_decided'
  | 'recovery_reconciled'
  | 'attempt_started'
  | 'attempt_finished'
  | 'attempt_failed'
  | 'attempt_suspended'
  | 'guidance_written'
  | 'guidance_delivery_checked'
  | 'command_timeout_projection'
  | 'stage_command_interrupt_requested'
  | 'stage_command_interrupted'
  | 'interrupted_command_repeated'
  | 'scheduler_loop_stalled'
  | 'scheduler_loop_recovered'
  | 'terminal_candidate_quarantined'
  | 'admission_rejected'
  | 'run_status_changed'
  | 'operator_wrap_up_required'
  | 'stage_complete'
  | 'stage_failed'
  | 'stage_skipped'
  | 'attempt_results_updated'
  | 'iteration_completed'
  | 'run_completed'
  | 'campaign_alert'
  | 'research_injected'
  | 'plan_dispatch_retry'
  | 'research_gate_exhausted'
  | 'research_round_contract_repaired'
  | 'research_gate_candidate_settled'
  | 'reality_gate_advisory'
  | 'parallel_scope_serialized'
  // Approval inbox: the run suspended on a consequential action, and the
  // resolution that released it. Part of the run's audit narrative — the only
  // place an operator sees WHY a run stopped without a verdict. Deliberately
  // NOT a summary-refresh trigger: an approval is not new measurable work.
  | 'approval_parked'
  | 'approval_attempt_suspended'
  | 'approval_resolved';

export interface RunEvent {
  type: RunEventType;
  runId: string;
  timestamp: string;
  iteration?: number;
  role?: string;
  disposition?: AttemptDisposition;
  stageId?: string;
  status?: StageStatus['status'];
  artifacts?: string[];
  detail?: string;
  level?: 'info' | 'warning';
  stageIds?: string[];
  files?: string[];
  attemptIndex?: number;
  attemptStartedAt?: string;
  exitCode?: number;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  providerFailure?: ProviderFailure;
  adapterFailure?: boolean;
  adapterFailureKind?: AdapterFailureKind;
  requestId?: string;
  requestingStageId?: string;
  requestedAt?: string;
  detectedAt?: string;
  boundary?: 'attempt_start' | 'adapter_invocation' | 'tool_call_start' | 'tool_call_completion' | 'operator_interrupt';
  invocationIndex?: number;
  round?: number;
  criteria?: string[];
  guidanceIds?: string[];
  guidanceId?: string;
  delivered?: boolean;
  commandId?: string;
  command?: string;
  commandFingerprint?: string;
  commandTimeoutMs?: number;
  remainingBudgetMs?: number;
  remainingMs?: number;
  finishingMs?: number;
  deadlineAt?: string;
  handoff?: string;
  shortfallMs?: number;
  originalRequestId?: string;
  decision?: 'accepted' | 'rejected' | 'discarded';
  source?: 'worker' | 'scheduler' | 'supervisor' | 'operator';
  runStatus?: StoreState['status'];
  gate?: StageStatus['gate'];
  /** Stable identity for retrying one cursor transition without duplicate events. */
  observationId?: string;
}

/** One projection for every attempt publisher, including scheduler reclassification.
 * Unknown/zero explicitly identify legacy ledgers; never infer a role from an ID
 * or borrow the current plan's iteration for an older execution. */
export function attemptEventFields(attempt: StageAttempt | undefined): Pick<RunEvent,
  'attemptIndex' | 'attemptStartedAt' | 'role' | 'iteration' | 'disposition'> {
  return {
    attemptIndex: attempt?.index,
    attemptStartedAt: attempt?.startedAt,
    role: attempt?.role ?? 'unknown',
    iteration: attempt?.iteration ?? 0,
    disposition: attempt?.status === STAGE_STATUS.RUNNING ? 'pending'
      : attempt?.status !== STAGE_STATUS.COMPLETE ? 'discarded'
      : attempt.disposition ?? 'accepted',
  };
}

function eventsPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'events.jsonl');
}

export function appendRunEvent(projectDir: string, runId: string, event: RunEvent): void {
  requireRunArtifactDirectory(projectDir, runId);
  appendTextRecord(eventsPath(projectDir, runId), JSON.stringify(event));
}

/** Append when a caller already owns the exact run directory. This keeps
 * guidance and negotiation events canonical without reverse-engineering the
 * project root from an arbitrary run path. */
export function appendRunEventAtRunDir(runDirectory: string, event: RunEvent): void {
  requireExistingRunArtifactDirectory(runDirectory);
  appendTextRecord(join(runDirectory, 'events.jsonl'), JSON.stringify(event));
}

export function readRunEvents(projectDir: string, runId: string, cursor?: JsonlReadCursor): RunEvent[] {
  try {
    return readJsonlFile<RunEvent>(eventsPath(projectDir, runId), cursor);
  } catch { /* no events file yet */
    return [];
  }
}

export function observeRunStatusChange(directory: string, runId: string, status: StoreState['status']): RunEvent[] {
  const cursorPath = join(directory, 'run_event_status.json');
  let committing = false;
  try {
    const cursor = existsSync(cursorPath)
      ? JSON.parse(readFileSync(cursorPath, 'utf-8')) as {
        status?: StoreState['status'];
        observedAt?: string;
      }
      : undefined;
    const prior = cursor?.status;
    if (prior === status) return [];
    const observationId = `${cursor?.observedAt ?? 'initial'}:${String(prior ?? 'unobserved')}->${String(status)}`;
    const recorded = readOptionalJsonlFile<RunEvent>(join(directory, 'events.jsonl'));
    const timestamp = recorded.find((event) => event.observationId === observationId)?.timestamp
      ?? new Date().toISOString();
    const events: RunEvent[] = [{
      type: 'run_status_changed', runId, timestamp, runStatus: status,
      detail: `run status ${prior === undefined ? 'initialized' : `changed from ${prior}`} to ${status}`,
      source: 'scheduler',
      observationId,
    }];
    if (isTerminalRunStatus(status) && !isTerminalRunStatus(prior)) {
      events.push({
        type: 'operator_wrap_up_required',
        runId,
        timestamp,
        runStatus: status,
        detail: `run reached terminal status ${status}; any linked open fc_tasks entry requires human wrap-up and explicit completion; terminal state is not acceptance`,
        level: 'warning',
        source: 'scheduler',
        observationId,
      });
    }
    const recordedTypes = new Set(recorded
      .filter((event) => event.observationId === observationId)
      .map((event) => event.type));
    committing = true;
    for (const event of events) {
      if (!recordedTypes.has(event.type)) appendRunEventAtRunDir(directory, event);
    }
    // The cursor is a commit record for the complete event set. It advances
    // only after every obligation it represents is durably appended.
    atomicWrite(cursorPath, `${JSON.stringify({ version: 1, status, observedAt: timestamp }, null, 2)}\n`);
    return events;
  } catch (error) {
    if (committing) throw error;
    return [];
  }
}

export function recordStageOutcome(
  projectDir: string,
  runId: string,
  stageId: string,
  iteration: number | undefined,
  status: StageStatus,
): void {
  if (!isSettledStageStatus(status.status) && status.status !== STAGE_STATUS.SKIPPED) {
    return;
  }

  const timestamp = status.completedAt ?? new Date().toISOString();
  const settledAttempt = status.attempts?.at(-1);
  const stageEvent: RunEvent = {
    type: status.status === STAGE_STATUS.COMPLETE
      ? 'stage_complete'
      : status.status === STAGE_STATUS.FAILED
        ? 'stage_failed'
        : 'stage_skipped',
    runId,
    timestamp,
    iteration,
    stageId,
    status: status.status,
    ...(status.gate ? { gate: status.gate } : {}),
    ...(settledAttempt ? attemptEventFields(settledAttempt) : {}),
  };

  appendRunEvent(projectDir, runId, stageEvent);
}

export function recordRunEvent(
  projectDir: string,
  runId: string,
  event: RunEvent,
): void {
  appendRunEvent(projectDir, runId, event);
}
