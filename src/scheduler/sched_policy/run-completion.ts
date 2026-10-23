// Boundary: Settle terminal research evidence before publishing a run's truthful outcome.
import { rejectPendingResearchGateCandidates } from '../../research-candidate.js';
import { readOptionalJsonlFile } from '../../jsonl.js';
import { recordRunEvent, type RunEvent } from '../../run-events.js';
import { type StoreState, evaluateRealityGate, isSuccessfulRunStatus, isTerminalRunStatus, runDir, writeRunState, updateOperationalRunState, interruptedStageStatus, resolveRunStatus, RUN_STATUS, STAGE_STATUS } from '../../store.js';
import { log } from '../sched_admission/shared.js';
import { join } from 'node:path';

/** Cleanup errors are recorded without replacing the result or an escaping exception. */
export function settleTerminalResearchCandidates(projectDir: string, state: StoreState | undefined): void {
  if (!state?.research || !isTerminalRunStatus(state.status)) return;
  try {
    const directory = runDir(projectDir, state.runId);
    // A fallback must not retry a failed cleanup after completion was published.
    // Match this outcome so a prior stopped run does not suppress resumed work.
    if (readOptionalJsonlFile<RunEvent>(join(directory, 'events.jsonl'))
      .some(event => event.type === 'run_completed' && event.timestamp === state.completedAt)) return;
    rejectPendingResearchGateCandidates(projectDir, directory, `Run ended ${state.status} before captured outcome ingestion: ${state.failureReason ?? 'terminal outcome settled'}`);
  } catch (error) {
    log.error({ err: error, runId: state.runId }, 'Failed to settle pending research gate candidates');
  }
}

export type RunConclusionReason =
  | 'workflow_complete' | 'stage_failed' | 'bounded_attempts' | 'validation_unresolved' | 'provider_refusal'
  | 'cancelled' | 'reality_gate_failed' | 'recovery_blocked' | 'scheduler_failed' | 'launch_conflict'
  | 'dispatch_refused' | 'workflow_refused' | 'admission_refused' | 'adapter_failure'
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
type ConclusionCommit = (state: StoreState, publish: () => void) => void;

export function concludeRun(state: StoreState, outcome: RunConclusion & {
  status: 'failed' | 'incomplete' | 'escalated' | 'cancelled' | 'reality_gate_failed';
}, commit?: ConclusionCommit): StoreState;
export function concludeRun(state: StoreState, outcome: RunConclusion, commit?: ConclusionCommit): StoreState | Promise<StoreState>;
export function concludeRun(state: StoreState, outcome: RunConclusion, commit?: ConclusionCommit): StoreState | Promise<StoreState> {
  if (!isTerminalRunStatus(outcome.status)) throw new Error(`Cannot conclude a run with status ${outcome.status}`);
  // Preserve the decision's original stage disposition before reality verification.
  // Status alone cannot distinguish a completed workflow from superseded work.
  if (outcome.pendingStageNote !== undefined) for (const stage of Object.values(state.stages)) {
    if (stage.status !== STAGE_STATUS.PENDING) continue;
    stage.status = STAGE_STATUS.SKIPPED;
    stage.error = outcome.pendingStageNote;
  }
  const finish = (): StoreState => {
    state.status = outcome.status;
    state.reasonCode = outcome.reasonCode;
    if (outcome.detail !== undefined) state.failureReason = outcome.detail;
    state.completedAt = outcome.completedAt ?? new Date().toISOString();
    settleTerminalResearchCandidates(state.projectDir, state);
    const publish = (): void => {
      outcome.writeCampaignEntry?.(state.projectDir, state);
      recordRunEvent(state.projectDir, state.runId, {
        type: 'run_completed', runId: state.runId, timestamp: state.completedAt!,
        ...(outcome.eventFields?.() ?? { iteration: state.currentIteration, detail: state.failureReason ?? state.status }),
      });
    };
    if (commit) commit(state, publish);
    else {
      writeRunState(state.projectDir, state.runId, state);
      publish();
    }
    return state;
  };
  if (!isSuccessfulRunStatus(outcome.status)) return finish();
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
  let publish: (() => void) | undefined;
  const state = updateOperationalRunState(directory, state => {
    if (resolveRunStatus(state.status).kind === 'unknown' || isTerminalRunStatus(state.status) && !(state.status === RUN_STATUS.FAILED && state.recovery?.kind === 'blocked')) {
      preservedRunStatus = state.status;
      return;
    }
    for (const [id, stage] of Object.entries(state.stages)) {
      state.stages[id] = interruptedStageStatus(stage, completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
      // Pending stages have no current execution to settle. Keep them runnable
      // for explicit continuation; the stopped run fences ordinary publication.
    }
    concludeRun(state, { status: RUN_STATUS.CANCELLED, reasonCode: 'cancelled', detail: 'Cancelled by user', completedAt },
      (_state, notify) => { publish = notify; });
  }, 'cancellation', () => publish?.());
  return { state, preservedRunStatus };
}
