// Boundary: Settle terminal research evidence before publishing a run's truthful outcome.
import { rejectPendingResearchGateCandidates } from '../../research-candidate.js';
import { readOptionalJsonlFile } from '../../jsonl.js';
import { recordRunEvent, type RunEvent } from '../../run-events.js';
import { type StoreState, isTerminalRunStatus, runDir, writeRunState } from '../../store.js';
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

/** Every completion publisher settles candidate evidence before state, campaign and event publication. */
export function publishRunCompletion(
  state: StoreState, projectDir: string, runId: string,
  eventFields: () => Omit<RunEvent, 'type' | 'runId' | 'timestamp'>,
  writeCampaignEntry?: (projectDir: string, state: StoreState) => void,
): void {
  settleTerminalResearchCandidates(projectDir, state);
  writeRunState(projectDir, runId, state);
  writeCampaignEntry?.(projectDir, state);
  recordRunEvent(projectDir, runId, {
    type: 'run_completed', runId, timestamp: state.completedAt!, ...eventFields(),
  });
}
