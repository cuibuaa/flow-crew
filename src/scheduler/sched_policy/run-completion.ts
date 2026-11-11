import { currentValidationResults } from '../sched_settlement/gate-validation.js';
import { projectValidationResult } from '../../project-validation.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prospectivePhysicalPath } from '../../engine-owned-carriers.js';
import { runRecordPath } from '../../run-layout.js';
// All research terminal reports share this commit boundary, including failures/cancellation.
import { writeResearchTerminalReport } from '../../research-measurement.js';
import { appendRunEventAtRunDir, attemptEventFields, readRunEvents, recordRunEvent, type RunEvent } from '../../run-events.js';
import { cancelledRunPublicationError } from '../../cancellation-policy.js';
import { type StoreState, researchReportCommits, withRunStateLock, runsRoot, evaluateRealityGate, isSuccessfulRunStatus, isTerminalRunStatus, updateRunState, updateOperationalRunState, interruptedStageStatus, resolveRunStatus, runDir, RUN_STATUS, STAGE_STATUS } from '../../store.js';

export type RunConclusionReason =
  | 'workflow_complete' | 'stage_failed' | 'bounded_attempts' | 'validation_unresolved' | 'provider_refusal'
  | 'cancelled' | 'reality_gate_failed' | 'recovery_blocked' | 'scheduler_failed' | 'launch_conflict'
  | 'dispatch_refused' | 'workflow_refused' | 'admission_refused' | 'adapter_failure' | 'input_too_large'
  | 'irreparable_gate_rejection' | 'gate_contract_refusal' | 'repeated_blockage' | 'terminal_artifact'
  | 'terminal_unmatched' | 'terminal_finalizer_unresolved' | 'terminal_owner_unresolved'
  | 'research_integrity_ceiling' | 'research_shipped' | 'research_ceiling' | 'research_budget_exhausted'
  | 'research_gate_exhausted' | 'study_complete' | 'declared_output_archival_refused';

interface RunConclusion {
  status: StoreState['status'];
  reasonCode: RunConclusionReason;
  detail?: string;
  completedAt?: string;
  /** A terminal decision can supersede work admitted for this iteration. */
  pendingStageNote?: string;
  eventFields?: () => Omit<RunEvent, 'type' | 'runId' | 'timestamp'>;
  writeCampaignEntry?: (projectDir: string, state: StoreState) => void;
}

/** A locked operational mutation supplies its existing commit boundary instead
 * of re-entering the run lock. Publication must run only after that commit. */
type ConclusionCommit = (state: StoreState, publish: (persist: () => void) => void) => void;

function hasResearchCompletion(state: StoreState): boolean {
  return readRunEvents(state.projectDir, state.runId).some(event => event.type === 'run_completed'
    && event.timestamp === state.completedAt && event.runStatus === state.status);
}

/** Idempotent projection of the committed research decision and measurement journal.
 * Runs under the existing state lock, both after conclusion and during recovery.
 * Destination intent distinguishes current engine-owned reports from archives. */
export function projectResearchConclusion(state: StoreState, persist: () => void): void {
  if (!state.research?.measurement || !state.researchReportPaths || !isTerminalRunStatus(state.status)) return;
  withRunStateLock(runsRoot(), () => projectResearchReports(state, persist));
}

function reportDestination(projectDir: string, path: string): string {
  const absolute = resolve(projectDir, path);
  try { return prospectivePhysicalPath(absolute); }
  catch { return absolute; } // The report author retains ordinary publication-error handling.
}

function projectResearchReports(state: StoreState, persist: () => void): void {
  const later = researchReportCommits(state.projectDir)
    .filter(other => other.runId !== state.runId && ((other.researchReportSequence ?? 0) > (state.researchReportSequence ?? 0)
      || state.researchReportSequence === undefined && other.researchReportSequence === undefined))
    .sort((a, b) => (b.researchReportSequence ?? 0) - (a.researchReportSequence ?? 0));
  const supersededPaths = (): Set<string> => {
    const superseded = new Set<string>();
    const events = readRunEvents(state.projectDir, state.runId);
    for (const path of state.researchReportPaths!) {
      const destination = reportDestination(state.projectDir, path);
      const owner = later.find(other => other.researchReportPaths!.some(path => reportDestination(other.projectDir, path) === destination));
      if (!owner) continue;
      superseded.add(path);
      const ownerRunId = owner.researchReportSequence === undefined ? undefined : owner.runId;
      const detail = ownerRunId
        ? `Report destination ${path} retained for later terminal publisher ${ownerRunId}`
        : `Report destination ${path} retained: conflicting terminal intent ${owner.runId}; historical publication order and ownership are unknown`;
      if (!events.some(event => event.type === 'research_report_superseded' && event.files?.includes(path) && event.detail === detail)) {
        recordRunEvent(state.projectDir, state.runId, {
          type: 'research_report_superseded', runId: state.runId, timestamp: new Date().toISOString(),
          level: 'warning', files: [path], ownerRunId, detail,
        });
      }
    }
    return superseded;
  };
  let pointer = state.terminalArtifact;
  const decision = () => JSON.stringify([state.status, state.reasonCode, state.failureReason, state.researchReportPaths]);
  const committed = decision();
  const superseded = supersededPaths();
  try {
    const errors = writeResearchTerminalReport(state, superseded);
    if (errors.length) throw new Error(errors.join('; '));
  } catch (error) {
    if (state.status !== RUN_STATUS.CANCELLED) { state.status = RUN_STATUS.FAILED; state.reasonCode = 'scheduler_failed'; }
    state.failureReason = `Research report publication refused: ${String(error)}`;
    state.researchReportPaths = [...new Set([
      ...state.researchReportPaths!, ...(state.terminalStates?.[state.status]?.paths ?? []),
    ])];
    if (decision() !== committed) {
      delete state.terminalArtifact;
      persist(); // Commit failure before correcting any exposed destination.
      pointer = state.terminalArtifact;
      writeResearchTerminalReport(state, supersededPaths());
    }
  }
  // Pointer-save errors propagate. Recovery re-derives the same projection;
  // a lost acknowledgement never invents another research decision.
  if (state.terminalArtifact !== pointer) persist();
  if (!hasResearchCompletion(state)) recordRunEvent(state.projectDir, state.runId, {
    type: 'run_completed', runId: state.runId, timestamp: state.completedAt!, runStatus: state.status,
    iteration: state.currentIteration, detail: state.failureReason ?? state.status,
  });
}

/** Explicit recovery/control entrance; ordinary archive readers remain read-only. */
export function reconcileResearchConclusion(projectDir: string, runId: string): StoreState {
  return updateOperationalRunState(runDir(projectDir, runId), () => {}, undefined, (state, persist) => {
    // Completed runs are historical evidence. In particular, a later run may
    // legitimately have replaced a shared project report with its own output.
    if (existsSync(runRecordPath(runDir(projectDir, runId), 'research_report.md'))
        && (!(state.terminalStates?.[state.status]?.paths.length) || state.terminalArtifact && existsSync(join(projectDir, state.terminalArtifact)))
        && hasResearchCompletion(state)) return;
    projectResearchConclusion(state, persist);
  });
}

export function concludeRun(state: StoreState, outcome: RunConclusion & {
  status: 'failed' | 'incomplete' | 'escalated' | 'cancelled' | 'reality_gate_failed';
}, commit?: ConclusionCommit): StoreState;
export function concludeRun(state: StoreState, outcome: RunConclusion, commit?: ConclusionCommit): StoreState | Promise<StoreState>;
export function concludeRun(state: StoreState, outcome: RunConclusion, commit?: ConclusionCommit): StoreState | Promise<StoreState> {
  if (!isTerminalRunStatus(outcome.status)) throw new Error(`Cannot conclude a run with status ${outcome.status}`);
  const callerState = state;
  // Preserve the decision's original stage disposition before reality verification.
  // Status alone cannot distinguish a completed workflow from superseded work.
  if (outcome.pendingStageNote !== undefined) for (const stage of Object.values(state.stages)) {
    if (stage.status !== STAGE_STATUS.PENDING) continue;
    stage.status = STAGE_STATUS.SKIPPED;
    stage.error = outcome.pendingStageNote;
  }
  const finish = (): StoreState => {
    const apply = (current: StoreState): void => {
      // Reports are part of the same locked decision as run.json. In particular,
      // an async measurement/reality result cannot publish past cancellation.
      if (current.status === RUN_STATUS.CANCELLED) {
        if (outcome.status !== RUN_STATUS.CANCELLED) throw cancelledRunPublicationError(current.runId);
        return;
      }
      Object.assign(current, state);
      current.validation = currentValidationResults(current.projectDir, current.runId).map(result => ({
        role: result.role, display: result.display, command: result.command, args: result.args, env: result.env, exitCode: result.exitCode, error: result.error, unfinished: result.unfinished, dependencyPreparationFailed: result.dependencyPreparationFailed, storedState: result.storedState ?? result.state,
        load: result.load, sourceBound: result.sourceBound, ...projectValidationResult(result),
      }));
      current.status = outcome.status;
      current.reasonCode = outcome.reasonCode;
      if (outcome.detail !== undefined) current.failureReason = outcome.detail;
      current.completedAt = outcome.completedAt ?? new Date().toISOString();
      if (current.research?.measurement) current.researchReportPaths = [...new Set([
        ...(current.researchReportPaths ?? []), ...(current.terminalStates?.[current.status]?.paths ?? []),
      ])];
    };
    let accepted = false;
    const publish = (persist: () => void): void => {
      if (!accepted) return;
      // The terminal decision and destination intent are durable before the
      // first report is exposed. No proposal or pending project report exists.
      projectResearchConclusion(state, persist);
      outcome.writeCampaignEntry?.(state.projectDir, state);
      if (!state.research?.measurement) recordRunEvent(state.projectDir, state.runId, {
        type: 'run_completed', runId: state.runId, timestamp: state.completedAt!,
        ...(outcome.eventFields?.() ?? { iteration: state.currentIteration, detail: state.failureReason ?? state.status }),
      });
    };
    if (commit) { apply(state); accepted = true; commit(state, publish); }
    else state = updateRunState(state.projectDir, state.runId, current => {
      accepted = current.status !== RUN_STATUS.CANCELLED || outcome.status === RUN_STATUS.CANCELLED;
      apply(current);
      state = current;
      Object.assign(callerState, current, { terminalArtifact: current.terminalArtifact });
    }, (_current, persist) => publish(persist));
    Object.assign(callerState, state, { terminalArtifact: state.terminalArtifact });
    return callerState;
  };
  if (!isSuccessfulRunStatus(outcome.status)) return finish();
  // Reality checks judge candidate evidence. The engine's own report is an
  // output of this decision, never a proposed input to its verification.
  return evaluateRealityGate(state.projectDir, state.runId, outcome.status).then(gate => {
    Object.assign(state, gate);
    if (gate.realityGate?.pass === false) {
      outcome = { ...outcome, status: 'reality_gate_failed', reasonCode: 'reality_gate_failed', detail: gate.failureReason };
    }
    return finish();
  });
}

/** Native cancellation fences the run and closes its interrupted stage ledgers together. */
export function cancelRunStateAtPath(directory: string, completedAt: string): { state: StoreState; preservedRunStatus?: string } {
  let preservedRunStatus: string | undefined;
  let publish: ((persist: () => void) => void) | undefined;
  const interrupted: RunEvent[] = [];
  const state = updateOperationalRunState(directory, state => {
    if (resolveRunStatus(state.status).kind === 'unknown' || isTerminalRunStatus(state.status) && !(state.status === RUN_STATUS.FAILED && state.recovery?.kind === 'blocked')) {
      preservedRunStatus = state.status;
      return;
    }
    for (const [id, stage] of Object.entries(state.stages)) {
      state.stages[id] = interruptedStageStatus(stage, completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
      const settled = state.stages[id];
      const attempt = settled.attempts?.at(-1);
      if (attempt && attempt !== stage.attempts?.at(-1)) interrupted.push({
        type: 'attempt_failed', runId: state.runId, timestamp: completedAt,
        stageId: id, ...attemptEventFields(attempt), status: settled.status, exitCode: attempt.exitCode,
        detail: attempt.error, source: 'scheduler',
      });
      // Pending stages have no current execution to settle. Keep them runnable
      // for explicit continuation; the stopped run fences ordinary publication.
    }
    concludeRun(state, { status: RUN_STATUS.CANCELLED, reasonCode: 'cancelled', detail: 'Cancelled by user', completedAt },
      (_state, notify) => { publish = notify; });
  }, 'cancellation', (_state, persist) => {
    for (const event of interrupted) appendRunEventAtRunDir(directory, event);
    if (publish) publish(persist);
    else projectResearchConclusion(_state, persist);
  });
  return { state, preservedRunStatus };
}
