import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Sequence prepared iterations, ordinary execution, fresh gate retry settlement, research advancement and final outcomes; calls responsibility owners.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { clearGateContinuationsForStages } from '../sched_admission/sessions.js';
import { isTerminalStatus } from '../sched_policy/identity.js';
import { recoverTerminalStudyCompletion } from '../sched_settlement/completion.js';
import { StoreState, RUN_STATUS, isContinuingStage, isPausedRunStatus, readRunState } from '../../store.js';
import { settleGateRetries } from './gate-loop.js';
import { concludeWorkflowIteration } from './iteration-outcome.js';
import { prepareWorkflowIteration } from './iteration-setup.js';
import { executeIteration } from './iteration.js';
import { advanceSettledResearch } from './research-progress.js';
import { createResearchBudgetFinalizer, settleExhaustedResearchGates } from './research-terminal.js';
import { writeCampaignEntry } from './services.js';
import { recordRunEvent } from '../../run-events.js';
import { parkAtDeploymentBoundary } from '../../deployment-hold.js';

export async function runWorkflowIterations(
  baseStages: StageConfig[], workflowYaml: string, maxIterations: number,
  resumeAtIteration: number, resumingExistingRun: boolean,
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
): Promise<StoreState> {
  const finishResearchCeiling = createResearchBudgetFinalizer(projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  const budgetBoundary = async (state: StoreState, iteration: number): Promise<boolean> => {
    const stageIds = Object.entries(state.stages).filter(([, stage]) => isContinuingStage(stage)).map(([id]) => id);
    if (!stageIds.length) return false;
    const maxWall = state.research?.stop?.maxWallHours;
    const wallExhausted = maxWall !== undefined && Date.now() - Date.parse(state.startedAt) >= maxWall * 3_600_000;
    recordRunEvent(projectDir, runId, { type: 'iteration_completed', runId, timestamp: new Date().toISOString(), iteration,
      detail: `Retained budget handoff for ${stageIds.join(', ')}; ${iteration}/${maxIterations} iterations spent`, source: 'scheduler' });
    if (iteration >= maxIterations || wallExhausted) {
      await concludeRun(state, { status: RUN_STATUS.INCOMPLETE, reasonCode: 'bounded_attempts',
        detail: `Retained stage work needs continuation, but ${wallExhausted ? 'research wall budget' : 'iteration budget'} is exhausted (${iteration}/${maxIterations}).`,
        eventFields: () => ({ iteration, detail: state.failureReason }), writeCampaignEntry });
    }
    return true;
  };
  for (let iteration = resumeAtIteration; iteration <= maxIterations; iteration++) {
    const held = parkAtDeploymentBoundary(projectDir, runId);
    if (held) return held;
    const prepared = await prepareWorkflowIteration(iteration, resumeAtIteration, resumingExistingRun, projectDir, runId, runDirPath, adapter, baseStages, workflowYaml);
    if (prepared.kind === 'settled') return prepared.state;
    const {sorted, injectedDispatchStages} = prepared;
    // Inner execution loop for this iteration
    await executeIteration(
      sorted, projectDir, runId, runDirPath, workflow, adapter, agents,
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, skills, taskDescription,
      availableSkillsList, attemptDeadlineClockFactory,
    );

    let state = readRunState(projectDir, runId);
    const heldAfterBatch = parkAtDeploymentBoundary(projectDir, runId);
    if (heldAfterBatch) return heldAfterBatch;

    // If the eager post-batch gate inside executeIteration already terminated
    // the run (set a terminal status + fired the hook), exit now — do NOT fall
    // through to the gate/allDone exits below, which would re-fire the hook.
    if (isTerminalStatus(state.status)) {
      clearGateContinuationsForStages(runDirPath, sorted);
      return state;
    }
    if (isPausedRunStatus(state.status)) return state;

    if (await budgetBoundary(state, iteration)) {
      if (state.status !== RUN_STATUS.RUNNING) return state;
      continue;
    }

    const recoveredTerminal = await recoverTerminalStudyCompletion(projectDir, runId, state, writeCampaignEntry);
    if (recoveredTerminal) {
      clearGateContinuationsForStages(runDirPath, sorted);
      return recoveredTerminal;
    }

    // Collect dispatched stage IDs (only from stages in the current sorted pipeline, not orphans)
    const baseIds = new Set(baseStages.map(s => s.id));
    const iterationDispatchedIds = sorted
      .filter(s => !baseIds.has(s.id))
      .map(s => s.id);
    const retried = await settleGateRetries(state, sorted, iteration, injectedDispatchStages, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (retried.kind === 'settled') return retried.state;
    const heldAfterRetries = parkAtDeploymentBoundary(projectDir, runId);
    if (heldAfterRetries) return heldAfterRetries;
    const {maxInnerRetries, innerRetriesUsed} = retried;
    // No gate session is useful beyond this iteration's bounded repair loop.
    // Passed, exhausted, and outer-replan paths all converge here.
    clearGateContinuationsForStages(runDirPath, sorted);

    state = readRunState(projectDir, runId);
    if (await budgetBoundary(state, iteration)) {
      if (state.status !== RUN_STATUS.RUNNING) return state;
      continue;
    }
    const exhaustedResearch = await settleExhaustedResearchGates(state, sorted, iteration, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (exhaustedResearch) return exhaustedResearch;
    const advanced = await advanceSettledResearch(state, sorted, baseStages, iteration, iterationDispatchedIds, innerRetriesUsed, maxInnerRetries, maxIterations, injectedDispatchStages, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
    if (advanced.kind === 'settled') return advanced.state;
    if (advanced.kind === 'next-iteration') continue;
    const outcome = await concludeWorkflowIteration(advanced.state, sorted, iteration, iterationDispatchedIds, innerRetriesUsed, maxInnerRetries, maxIterations, finishResearchCeiling, projectDir, runId, runDirPath, adapter, injectedDispatchStages);
    if (outcome.kind === 'settled') return outcome.state;
  }
  // Should not reach here, but safety net
  const finalState = readRunState(projectDir, runId);
  // Preserve an already settled terminal or parked state.
  if (isTerminalStatus(finalState.status)) return finalState;
  return concludeRun(finalState, { status: RUN_STATUS.FAILED, reasonCode: 'scheduler_failed', detail: 'Workflow ended unexpectedly.',
    eventFields: () => ({ iteration: finalState.currentIteration, detail: finalState.status }), writeCampaignEntry });
}
