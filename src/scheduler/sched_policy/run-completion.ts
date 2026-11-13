import { RESEARCH_PROTOCOL } from '../../research-instrument.js';
import { log } from '../sched_admission/shared.js';
import { currentValidationResults } from '../sched_settlement/gate-validation.js';
import { projectValidationResult } from '../../project-validation.js';
import { writeResearchTerminalReport, reconcileResearchManifest } from '../../research-measurement.js';
import { appendRunEventAtRunDir, attemptEventFields, recordRunEvent, type RunEvent } from '../../run-events.js';
import { cancelledRunPublicationError } from '../../cancellation-policy.js';
import { type StoreState, evaluateRealityGate, isSuccessfulRunStatus, isTerminalRunStatus, updateRunState, readRunState, updateOperationalRunState, interruptedStageStatus, resolveRunStatus, runDir, RUN_STATUS, STAGE_STATUS } from '../../store.js';

export type RunConclusionReason =
  | 'workflow_complete' | 'stage_failed' | 'bounded_attempts' | 'validation_unresolved' | 'provider_refusal'
  | 'cancelled' | 'reality_gate_failed' | 'recovery_blocked' | 'scheduler_failed' | 'launch_conflict'
  | 'dispatch_refused' | 'workflow_refused' | 'admission_refused' | 'adapter_failure' | 'input_too_large'
  | 'irreparable_gate_rejection' | 'gate_contract_refusal' | 'repeated_blockage' | 'terminal_artifact'
  | 'artifact_ownership_unverified' | 'terminal_unmatched' | 'terminal_finalizer_unresolved'
  | 'research_integrity_ceiling' | 'research_shipped' | 'research_ceiling' | 'research_budget_exhausted'
  | 'research_gate_exhausted' | 'study_complete' | 'declared_output_archival_refused';

interface RunConclusion {
  status: StoreState['status'];
  reasonCode: RunConclusionReason;
  detail?: string;
  completedAt?: string;
  /** A terminal decision can supersede work admitted for this iteration. */
  pendingStageNote?: string;
  beforeCommit?: (state: StoreState) => void;
  eventFields?: () => Omit<RunEvent, 'type' | 'runId' | 'timestamp'>;
  writeCampaignEntry?: (projectDir: string, state: StoreState) => void;
}

/** A locked operational mutation supplies its existing commit boundary instead
 * of re-entering the run lock. */
type ConclusionCommit = (state: StoreState, publish: (persist: () => void) => void) => void;

/** The terminal publisher delivers the durable finalizer's report before the
 * current-tree validation projection and terminal result are committed. */
export function projectResearchConclusion(state: StoreState, _persist: () => void): void {
  if (state.research?.protocol === RESEARCH_PROTOCOL && isTerminalRunStatus(state.status)) {
    try { reconcileResearchManifest(runDir(state.projectDir, state.runId), state); writeResearchTerminalReport(state); }
    catch (error) { log.warn({ runId: state.runId, error: String(error) }, 'Research publication receipt unavailable'); }
  }
}
/** Recovery is read-only with respect to project files, including missing reports. */
export function reconcileResearchConclusion(projectDir: string, runId: string): StoreState {
  const state = readRunState(projectDir, runId);
  if (state.research?.protocol === RESEARCH_PROTOCOL) reconcileResearchManifest(runDir(projectDir, runId), state);
  return state;
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
      current.status = outcome.status;
      current.reasonCode = outcome.reasonCode;
      if (outcome.detail !== undefined) current.failureReason = outcome.detail;
      outcome.beforeCommit?.(current);
      current.validation = currentValidationResults(current.projectDir, current.runId).map(result => ({
        role: result.role, display: result.display, command: result.command, args: result.args, env: result.env, totals: result.totals, testsRun: result.testsRun, failureCount: result.failureCount, exitCode: result.exitCode, error: result.error, unfinished: result.unfinished, dependencyPreparationFailed: result.dependencyPreparationFailed, storedState: result.storedState ?? result.state,
        load: result.load, sourceBound: result.sourceBound, ...projectValidationResult(result),
      }));
      // Successful publication requires completed current-tree exits. Engine
      // finalizers may have replaced the tree since the last author settlement.
      if (isSuccessfulRunStatus(current.status) && current.validation.some(result => result.state !== 'passed')) {
        current.status = RUN_STATUS.INCOMPLETE;
        current.reasonCode = 'validation_unresolved';
        current.failureReason = 'Current-tree validation is unfinished, missing or rejected; successful publication requires completed zero exits.';
      }
      current.completedAt = outcome.completedAt ?? new Date().toISOString();
    };
    let accepted = false;
    const publish = (_persist: () => void): void => {
      if (!accepted) return;
      // The delivered tree and its validation disposition are committed before
      // publishing terminal events and campaign entries.
      outcome.writeCampaignEntry?.(state.projectDir, state);
      recordRunEvent(state.projectDir, state.runId, {
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
  if (state.research?.protocol === RESEARCH_PROTOCOL || !isSuccessfulRunStatus(outcome.status)) return finish();
  // Reality checks judge candidate evidence. The engine's own report is an
  // output of this decision, never a proposed input to its verification.
  return evaluateRealityGate(state.projectDir, state.runId, outcome.status).then(gate => {
    Object.assign(state, gate);
    if (gate.realityGate?.results.some(item => item.unfinished && !item.advisory)) {
      // A resource receipt cannot publish the candidate's success or failure.
      const parked = updateRunState(state.projectDir, state.runId, current => {
        if (current.status === RUN_STATUS.CANCELLED) return;
        current.realityGate = gate.realityGate;
        current.status = RUN_STATUS.PARKED;
        current.recovery = { kind: 'resumable', cause: 'work_unfinished', at: new Date().toISOString(), interruptedStages: [],
          reason: `Reality check unfinished; recorded command facts: ${gate.realityGate!.artifactPath}` };
      });
      Object.assign(callerState, parked);
      return callerState;
    }
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
  });
  return { state, preservedRunStatus };
}
