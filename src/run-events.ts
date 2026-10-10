import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendTextRecord } from './append-boundary.js';
import { readJsonlFile } from './jsonl.js';
import type { StageStatus, StoreState } from './store.js';
import type { AdapterFailureKind } from './adapters/base.js';
import type { ProviderFailure } from './provider-result.js';
import { atomicWrite, isSettledStageStatus, isTerminalRunStatus, requireExistingRunArtifactDirectory, requireRunArtifactDirectory, runDir, STAGE_STATUS } from './store.js';

export type RunEventType =
  | 'stage_environment_wait_started'
  | 'stage_environment_wait_finished'
  | 'resource_lease_decided'
  | 'resource_lease_retained'
  | 'resource_lease_wait_started'
  | 'resource_lease_wait_finished'
  | 'plan_revision_decided'
  | 'recovery_reconciled'
  | 'attempt_started'
  | 'attempt_finished'
  | 'attempt_failed'
  | 'attempt_suspended'
  | 'guidance_written'
  | 'guidance_delivery_checked'
  | 'stage_command_started'
  | 'stage_command_completed'
  | 'command_timeout_projection'
  | 'stage_command_interrupt_requested'
  | 'stage_command_interrupted'
  | 'interrupted_command_repeated'
  | 'criterion_check_conflict'
  | 'scope_revision_requested'
  | 'scope_revision_decided'
  | 'live_constraint_violation'
  | 'live_constraint_comparison_unavailable'
  | 'live_constraint_exemptions'
  | 'live_constraint_monitor_failure'
  | 'scheduler_loop_stalled'
  | 'scheduler_loop_recovered'
  | 'terminal_candidate_quarantined'
  | 'admission_rejected'
  | 'run_status_changed'
  | 'operator_wrap_up_required'
  | 'supervisor_assessment'
  | 'supervisor_reject_requested'
  | 'supervisor_reject_discarded'
  | 'stage_complete'
  | 'stage_failed'
  | 'stage_skipped'
  | 'verdict_written'
  | 'attempt_results_updated'
  | 'iteration_completed'
  | 'run_completed'
  | 'campaign_alert'
  | 'research_injected'
  | 'supervisor_replan'
  | 'supervisor_reject'
  | 'plan_dispatch_retry'
  | 'research_mode_degraded'
  | 'research_gate_exhausted'
  | 'research_round_contract_repaired'
  | 'stage_artifact_contract_violation'
  | 'reality_gate_advisory'
  | 'parallel_scope_serialized'
  | 'parallel_write_conflict'
  | 'writer_lease_wait_started'
  | 'writer_lease_wait_finished'
  | 'attempt_summary_refresh_requested'
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
  ruleId?: string;
  blockedByStageId?: string;
  requestingStageId?: string;
  leasePartition?: string;
  waitStartedAt?: string;
  waitedMs?: number;
  requestedAt?: string;
  detectedAt?: string;
  boundary?: 'attempt_start' | 'adapter_invocation' | 'tool_call_start' | 'tool_call_completion' | 'operator_interrupt';
  invocationIndex?: number;
  exemptedCount?: number;
  lastScanDurationMs?: number;
  lastScanFileCount?: number;
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
  shortfallMs?: number;
  originalRequestId?: string;
  criterionId?: string;
  checkPath?: string;
  authorStageId?: string;
  decision?: 'accepted' | 'rejected' | 'discarded';
  evidenceGeneration?: string;
  assessmentId?: string;
  supersedesAssessmentId?: string;
  supervisorVerdict?: string;
  evidenceIds?: string[];
  source?: 'worker' | 'scheduler' | 'supervisor' | 'operator';
  runStatus?: StoreState['status'];
  /** Stable identity for retrying one cursor transition without duplicate events. */
  observationId?: string;
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

export function readRunEvents(projectDir: string, runId: string): RunEvent[] {
  try {
    return readJsonlFile<RunEvent>(eventsPath(projectDir, runId));
  } catch { /* no events file yet */
    return [];
  }
}

function buildArtifactEvents(runId: string, event: RunEvent): RunEvent[] {
  const artifactEvents: RunEvent[] = [];
  const artifacts = event.artifacts ?? [];
  const verdictArtifacts = artifacts.filter((artifact) => /(^|\/)verdict(_|\.|\/)/i.test(artifact));
  if (verdictArtifacts.length > 0) {
    artifactEvents.push({
      type: 'verdict_written',
      runId,
      timestamp: event.timestamp,
      iteration: event.iteration,
      stageId: event.stageId,
      artifacts: verdictArtifacts,
    });
  }
  const resultArtifacts = artifacts.filter((artifact) =>
    /(^|\/)(attempt|attempts|result|results|metrics|score|table)/i.test(artifact),
  );
  if (resultArtifacts.length > 0) {
    artifactEvents.push({
      type: 'attempt_results_updated',
      runId,
      timestamp: event.timestamp,
      iteration: event.iteration,
      stageId: event.stageId,
      artifacts: resultArtifacts,
    });
  }
  return artifactEvents;
}

function observeRunStatusChange(projectDir: string, runId: string): RunEvent[] {
  const directory = runDir(projectDir, runId);
  const cursorPath = join(directory, 'run_event_status.json');
  let committing = false;
  try {
    const status = (JSON.parse(readFileSync(join(directory, 'run.json'), 'utf-8')) as StoreState).status;
    const cursor = existsSync(cursorPath)
      ? JSON.parse(readFileSync(cursorPath, 'utf-8')) as {
        status?: StoreState['status'];
        observedAt?: string;
      }
      : undefined;
    const prior = cursor?.status;
    if (prior === status) return [];
    const observationId = `${cursor?.observedAt ?? 'initial'}:${String(prior ?? 'unobserved')}->${String(status)}`;
    const recorded = readRunEvents(projectDir, runId);
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
      if (!recordedTypes.has(event.type)) appendRunEvent(projectDir, runId, event);
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
  /** @deprecated Events append synchronously; no refresh is scheduled. */
  _options?: { debounceMs?: number },
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
    artifacts: status.artifacts,
    attemptIndex: settledAttempt?.index,
    attemptStartedAt: settledAttempt?.startedAt,
  };

  const events = [stageEvent, ...buildArtifactEvents(runId, stageEvent)];
  for (const event of events) appendRunEvent(projectDir, runId, event);
  observeRunStatusChange(projectDir, runId);
}

export function recordRunEvent(
  projectDir: string,
  runId: string,
  event: RunEvent,
  /** @deprecated Events append synchronously; no refresh is scheduled. */
  _options?: { debounceMs?: number },
): void {
  appendRunEvent(projectDir, runId, event);
  if (event.type !== 'run_status_changed') observeRunStatusChange(projectDir, runId);
}

// Compatibility for validation cleanup hooks. There are no deferred event
// writes to cancel; historical maintenance events remain readable.
export function clearAttemptSummaryRefreshDebounce(): void {}
