import { publishRunCompletion } from './iteration-outcome.js';
// Boundary: Sequence prepared iterations, ordinary execution, fresh gate retry settlement, research advancement and final outcomes; calls responsibility owners.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { clearGateContinuationsForStages } from '../sched_admission/sessions.js';
import { isTerminalStatus } from '../sched_policy/identity.js';
import { recoverTerminalStudyCompletion } from '../sched_settlement/completion.js';
import { StoreState, isPausedRunStatus, readRunState, writeRunState } from '../../store.js';
import { settleGateRetries } from './gate-loop.js';
import { concludeWorkflowIteration } from './iteration-outcome.js';
import { prepareWorkflowIteration } from './iteration-setup.js';
import { executeIteration } from './iteration.js';
import { advanceSettledResearch } from './research-progress.js';
import { createResearchBudgetFinalizer, settleExhaustedResearchGates } from './research-terminal.js';
import { archiveDeclaredOutputsBeforePlainCompletion, writeCampaignEntry } from './services.js';

export async function runWorkflowIterations(
  baseStages: StageConfig[], workflowYaml: string, maxIterations: number,
  resumeAtIteration: number, resumingFromPark: boolean,
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
): Promise<StoreState> {
  const finishResearchCeiling = createResearchBudgetFinalizer(projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  for (let iteration = resumeAtIteration; iteration <= maxIterations; iteration++) {
    const prepared = await prepareWorkflowIteration(iteration, resumeAtIteration, resumingFromPark, projectDir, runId, runDirPath, adapter, baseStages, workflowYaml);
    if (prepared.kind === 'settled') return prepared.state;
    const {sorted, injectedDispatchStages, planStageRetries} = prepared;
    // Inner execution loop for this iteration
    await executeIteration(
      sorted, projectDir, runId, runDirPath, workflow, adapter, agents,
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries, skills, taskDescription,
      availableSkillsList, attemptDeadlineClockFactory,
    );

    let state = readRunState(projectDir, runId);

    // If the eager post-batch gate inside executeIteration already terminated
    // the run (set a terminal status + fired the hook), exit now — do NOT fall
    // through to the gate/allDone exits below, which would re-fire the hook.
    if (isTerminalStatus(state.status)) {
      clearGateContinuationsForStages(runDirPath, sorted);
      return state;
    }
    if (isPausedRunStatus(state.status)) return state;

    const recoveredTerminal = recoverTerminalStudyCompletion(projectDir, runId, state);
    if (recoveredTerminal) {
      clearGateContinuationsForStages(runDirPath, sorted);
      if (!archiveDeclaredOutputsBeforePlainCompletion(
        recoveredTerminal,
        { projectDir, runId, runDirPath, iteration },
        'terminal_study_recovery',
      )) return recoveredTerminal;
      writeRunState(projectDir, runId, recoveredTerminal);
      writeCampaignEntry(projectDir, recoveredTerminal);
      return recoveredTerminal;
    }

    // Collect dispatched stage IDs (only from stages in the current sorted pipeline, not orphans)
    const baseIds = new Set(baseStages.map(s => s.id));
    const iterationDispatchedIds = sorted
      .filter(s => !baseIds.has(s.id))
      .map(s => s.id);
    const retried = await settleGateRetries(state, sorted, iteration, iterationDispatchedIds, injectedDispatchStages, planStageRetries, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (retried.kind === 'settled') return retried.state;
    const {maxInnerRetries, innerRetriesUsed} = retried;
    // No gate session is useful beyond this iteration's bounded repair loop.
    // Passed, exhausted, and outer-replan paths all converge here.
    clearGateContinuationsForStages(runDirPath, sorted);

    state = readRunState(projectDir, runId);
    const exhaustedResearch = await settleExhaustedResearchGates(state, sorted, iteration, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (exhaustedResearch) return exhaustedResearch;
    const advanced = await advanceSettledResearch(state, sorted, baseStages, iteration, iterationDispatchedIds, innerRetriesUsed, maxInnerRetries, maxIterations, injectedDispatchStages, planStageRetries, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (advanced.kind === 'settled') return advanced.state;
    if (advanced.kind === 'next-iteration') continue;
    const outcome = await concludeWorkflowIteration(advanced.state, sorted, iteration, iterationDispatchedIds, innerRetriesUsed, maxIterations, finishResearchCeiling, projectDir, runId, runDirPath, adapter, injectedDispatchStages, planStageRetries);
    if (outcome.kind === 'settled') return outcome.state;
  }
  // Should not reach here, but safety net
  const finalState = readRunState(projectDir, runId);
  // Preserve an already settled terminal or parked state.
  if (isTerminalStatus(finalState.status)) return finalState;
  finalState.status = 'failed';
  finalState.failureReason = 'Workflow ended unexpectedly.';
  finalState.completedAt = new Date().toISOString();
  publishRunCompletion(finalState, projectDir, runId, () => ({iteration: finalState.currentIteration, detail: finalState.status}));
  return finalState;
}
