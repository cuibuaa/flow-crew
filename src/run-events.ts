import { runRecordPath } from './run-layout.js';
import { appendTextRecord } from './append-boundary.js';
import { readJsonlFile, type JsonlReadCursor } from './jsonl.js';
import type { AttemptDisposition, StageAttempt, StageStatus, StoreState } from './store.js';
import type { AdapterFailureKind } from './adapters/base.js';
import type { ProviderFailure } from './provider-result.js';
import { isSettledStageStatus, requireExistingRunArtifactDirectory, requireRunArtifactDirectory, runDir, STAGE_STATUS } from './store.js';

export type RunEventType =
  | 'decision_chosen' | 'decision_defaulted' | 'decision_refused'
  | 'execution_notice'
  | 'stage_wrap_up_delivered'
  | 'stage_wrap_up_forced'
  | 'plan_revision_decided'
  | 'recovery_reconciled'
  | 'attempt_started'
  | 'attempt_finished'
  | 'attempt_failed'
  | 'guidance_written'
  | 'guidance_delivery_checked'
  | 'command_timeout_projection'
  | 'stage_command_interrupt_requested'
  | 'stage_command_interrupted'
  | 'interrupted_command_repeated'
  | 'scheduler_loop_stalled'
  | 'scheduler_loop_recovered'
  | 'admission_rejected'
  | 'run_status_changed'
  | 'run_status_imported'
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
  | 'reality_gate_advisory'
  | 'parallel_scope_serialized';

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
  ownerRunId?: string;
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
  boundary?: 'attempt_start' | 'adapter_invocation' | 'tool_call_start' | 'tool_call_completion' | 'operator_interrupt' | 'model_submission';
  invocationIndex?: number;
  round?: number;
  criteria?: string[];
  guidanceIds?: string[];
  guidanceId?: string;
  delivered?: boolean;
  commandId?: string;
  commandIds?: string[];
  retiredCommandIds?: string[];
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
  lifecycleVersion?: 1;
  wrapUpRequired?: true;
  snapshotSource?: 'run.json';
  snapshotStatus?: unknown;
  /** Identity shared by a lifecycle decision and its wrap-up notice. */
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
  return runRecordPath(runDir(projectDir, runId), 'events.jsonl');
}

export function appendRunEvent(projectDir: string, runId: string, event: RunEvent): void {
  requireRunArtifactDirectory(projectDir, runId);
  requireNonLifecycleEvent(event);
  appendTextRecord(eventsPath(projectDir, runId), JSON.stringify(event));
}

/** Append when a caller already owns the exact run directory. This keeps
 * guidance and negotiation events canonical without reverse-engineering the
 * project root from an arbitrary run path. */
export function appendRunEventAtRunDir(runDirectory: string, event: RunEvent): void {
  requireExistingRunArtifactDirectory(runDirectory);
  requireNonLifecycleEvent(event);
  appendTextRecord(runRecordPath(runDirectory, 'events.jsonl'), JSON.stringify(event));
}

function requireNonLifecycleEvent(event: RunEvent): void {
  if (event.type === 'run_status_changed' || event.type === 'run_status_imported') {
    throw new Error('Lifecycle events require the locked durable publication boundary');
  }
}

export function readRunEvents(projectDir: string, runId: string, cursor?: JsonlReadCursor): RunEvent[] {
  try {
    return readJsonlFile<RunEvent>(eventsPath(projectDir, runId), cursor);
  } catch { /* no events file yet */
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
    ...(settledAttempt?.exitCode === undefined ? {} : { exitCode: settledAttempt.exitCode }),
    ...(settledAttempt?.providerFailure ? { providerFailure: settledAttempt.providerFailure } : {}),
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
