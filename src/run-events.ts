import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendTextRecord } from './append-boundary.js';
import { readJsonlFile } from './jsonl.js';
import type { StageStatus, StoreState } from './store.js';
import { atomicWrite, isSettledStageStatus, isTerminalRunStatus, requireExistingRunArtifactDirectory, requireRunArtifactDirectory, runDir, STAGE_STATUS } from './store.js';

export type RunEventType =
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
  adapterFailure?: boolean;
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

export interface AttemptSummaryRefreshState {
  refreshVersion: number;
  pending: boolean;
  requestedAt?: string;
  scheduledAt?: string;
  reasons: string[];
  sourceEventTypes: RunEventType[];
}

const DEFAULT_DEBOUNCE_MS = 250;
const debounceTimers = new Map<string, NodeJS.Timeout>();

function eventsPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'events.jsonl');
}

function refreshStatePath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'attempt_summary_refresh.json');
}

function refreshTimerKey(projectDir: string, runId: string): string {
  return `${projectDir}::${runId}`;
}

function inferSummaryRefreshReasons(event: RunEvent): string[] {
  const reasons = new Set<string>();

  switch (event.type) {
    case 'stage_complete':
    case 'stage_failed':
    case 'stage_skipped':
      reasons.add(event.type);
      break;
    case 'verdict_written':
    case 'attempt_results_updated':
    case 'iteration_completed':
    case 'run_completed':
    case 'run_status_changed':
    case 'operator_wrap_up_required':
      reasons.add(event.type);
      break;
    default:
      break;
  }

  return [...reasons];
}

function readRefreshState(projectDir: string, runId: string): AttemptSummaryRefreshState {
  try {
    return JSON.parse(readFileSync(refreshStatePath(projectDir, runId), 'utf-8')) as AttemptSummaryRefreshState;
  } catch { /* non-critical */
    return {
      refreshVersion: 0,
      pending: false,
      reasons: [],
      sourceEventTypes: [],
    };
  }
}

function writeRefreshState(projectDir: string, runId: string, state: AttemptSummaryRefreshState): void {
  requireRunArtifactDirectory(projectDir, runId);
  atomicWrite(refreshStatePath(projectDir, runId), JSON.stringify(state, null, 2));
}

export function readAttemptSummaryRefreshState(
  projectDir: string,
  runId: string,
): AttemptSummaryRefreshState | null {
  if (!existsSync(refreshStatePath(projectDir, runId))) return null;
  return readRefreshState(projectDir, runId);
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

export function requestAttemptSummaryRefresh(
  projectDir: string,
  runId: string,
  sourceEvents: RunEvent[],
  options?: { debounceMs?: number },
): void {
  if (sourceEvents.length === 0) return;
  const relevantSourceEvents = sourceEvents.filter((event) => inferSummaryRefreshReasons(event).length > 0);
  if (relevantSourceEvents.length === 0) return;

  const key = refreshTimerKey(projectDir, runId);
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = new Date().toISOString();
  const existing = readRefreshState(projectDir, runId);
  const reasons = new Set(existing.reasons);
  const eventTypes = new Set(existing.sourceEventTypes);

  for (const event of relevantSourceEvents) {
    eventTypes.add(event.type);
    for (const reason of inferSummaryRefreshReasons(event)) reasons.add(reason);
  }

  writeRefreshState(projectDir, runId, {
    ...existing,
    pending: true,
    requestedAt: now,
    reasons: [...reasons],
    sourceEventTypes: [...eventTypes],
  });

  const activeTimer = debounceTimers.get(key);
  if (activeTimer) clearTimeout(activeTimer);

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    try {
      const latest = readRefreshState(projectDir, runId);
      const scheduledAt = new Date().toISOString();
      const nextState: AttemptSummaryRefreshState = {
        ...latest,
        refreshVersion: latest.refreshVersion + 1,
        pending: false,
        scheduledAt,
      };
      writeRefreshState(projectDir, runId, nextState);
      appendRunEvent(projectDir, runId, {
        type: 'attempt_summary_refresh_requested',
        runId,
        timestamp: scheduledAt,
        detail: nextState.reasons.join(', '),
      });
    } catch {
      // A run may be cleaned after the refresh was scheduled. Never recreate
      // the directory or turn that expected race into an uncaught exception.
    }
  }, debounceMs);

  debounceTimers.set(key, timer);
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
  options?: { debounceMs?: number },
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
  const statusEvents = observeRunStatusChange(projectDir, runId);
  for (const statusEvent of statusEvents) {
    events.push(statusEvent);
  }
  requestAttemptSummaryRefresh(projectDir, runId, events, options);
}

export function recordRunEvent(
  projectDir: string,
  runId: string,
  event: RunEvent,
  options?: { debounceMs?: number },
): void {
  appendRunEvent(projectDir, runId, event);
  const events = [event];
  if (event.type !== 'run_status_changed') {
    const statusEvents = observeRunStatusChange(projectDir, runId);
    for (const statusEvent of statusEvents) {
      events.push(statusEvent);
    }
  }
  requestAttemptSummaryRefresh(projectDir, runId, events, options);
}

export function clearAttemptSummaryRefreshDebounce(projectDir?: string, runId?: string): void {
  if (projectDir && runId) {
    const key = refreshTimerKey(projectDir, runId);
    const timer = debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
    return;
  }

  for (const [key, timer] of debounceTimers) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
}
