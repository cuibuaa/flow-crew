// Boundary: Advance one admitted DAG until quiescence, park or terminal state; planner admission and ordinary batch execution own their independent loops.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { RUN_STATUS, StoreState, isAwaitingApprovalRunStatus, isPausedRunStatus, isTerminalRunStatus, readRunState, writeRunState } from '../../store.js';
import { admitPlannerDispatches } from './planner-dispatch.js';
import { consumePlanRevisions } from './services.js';
import { executeReadyBatch } from './stage-batch.js';

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
    let state = readRunState(projectDir, runId);
    if (state.status === RUN_STATUS.RUNNING) state = consumePlanRevisions(sorted, state, projectDir, runId, runDirPath, workflow, roleRegistry);

    // Exit if run was cancelled or reached any terminal state externally
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    // A park RETURNS (process exits, project frees, daemon queue advances) —
    // deliberately NOT the legacy plan-review busy-poll below, which holds the
    // process and the project lock while it waits.
    if (isPausedRunStatus(state.status)) {
      return state;
    }

    // Poll while awaiting approval
    if (isAwaitingApprovalRunStatus(state.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const admitted = admitPlannerDispatches(sorted, state, projectDir, runId, runDirPath, roleRegistry, injectedDispatchStages, planStageRetries, taskDescription);
    if (admitted.kind === 'settled') return admitted.state;
    state = admitted.state;
    if (isAwaitingApprovalRunStatus(state.status)) {
      // Auto-approve on iteration 2+ (re-plans) when autoApproveRetries is not explicitly false.
      // First iteration always requires manual approval so the user can review the plan,
      // unless autoApprove is explicitly true (API-created autonomous tasks).
      const currentIter = state.currentIteration ?? 1;
      if ((currentIter > 1 && state.autoApproveRetries !== false) || state.autoApprove === true) {
        state.status = RUN_STATUS.RUNNING;
        writeRunState(projectDir, runId, state);
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const batch = await executeReadyBatch(sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, technicalRetries, skills, taskDescription, availableSkills, attemptDeadlineClockFactory);
    if (batch.kind === 'settled') return batch.state;
  }
}
