// Boundary: Advance one admitted DAG until quiescence, park or terminal state; planner admission and ordinary batch execution own their independent loops.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { RUN_STATUS, StoreState, isContinuingStage, isAwaitingApprovalRunStatus, isPausedRunStatus, isTerminalRunStatus, readRunState } from '../../store.js';
import { admitPlannerDispatches } from './planner-dispatch.js';
import { consumePlanRevisions } from './services.js';
import { executeReadyBatch } from './stage-batch.js';
import { parkAtDeploymentBoundary } from '../../deployment-hold.js';

export async function executeIteration(
  sorted: StageConfig[],
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  injectedDispatchStages: Set<string>,
  planStageRetries: Map<string, number>,
  skills?: string,
  taskDescription?: string,
  availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<StoreState> {
  const technicalRetries = new Map<string, TechnicalRetryBudgetState>();
  while (true) {
    const held = parkAtDeploymentBoundary(projectDir, runId);
    if (held) return held;
    let state = readRunState(projectDir, runId);
    if (state.status === RUN_STATUS.RUNNING) state = consumePlanRevisions(sorted, state, projectDir, runId, runDirPath, workflow, roleRegistry);

    // Exit if run was cancelled or reached any terminal state externally
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    // Suspended runs return and release execution ownership, including archived
    // legacy plan-review states that no current admission path creates.
    if (isPausedRunStatus(state.status) || isAwaitingApprovalRunStatus(state.status)) {
      return state;
    }

    // A completed slice cannot release dependencies or spend another slice in
    // this iteration. The outer loop owns the finite continuation budget.
    if (Object.values(state.stages).some(isContinuingStage)) return state;

    const admitted = admitPlannerDispatches(sorted, state, projectDir, runId, runDirPath, roleRegistry, injectedDispatchStages, planStageRetries, taskDescription);
    if (admitted.kind === 'settled') return admitted.state;
    state = admitted.state;
    const batch = await executeReadyBatch(sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, technicalRetries, skills, taskDescription, availableSkills, attemptDeadlineClockFactory);
    if (batch.kind === 'settled') return batch.state;
  }
}
