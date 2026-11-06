import { buildRoleRegistry } from '../sched_admission/dispatch.js';
/** Compatibility call for library consumers; all work goes through the declared-edge iteration. */
import type { Adapter, AgentConfig } from '../../adapters/base.js';
import type { AttemptDeadlineClock } from '../../attempt-deadline.js';
import type { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { loadDefaults } from '../sched_admission/configuration.js';
import { readRunState, isPausedRunStatus, isTerminalRunStatus, type StoreState } from '../../store.js';
import { executeIteration } from './iteration.js';
export async function settleGateRetries(state: StoreState, sorted: StageConfig[], iteration: number, injected: Set<string>,
  project: string, run: string, directory: string, workflow: WorkflowConfig, adapter: Adapter,
  agents: Map<string, AgentConfig>, agentsDir: string, roles: Map<string, {name: string; description: string}>,
  skills?: string, task?: string, availableSkills?: string, clock?: () => AttemptDeadlineClock,
): Promise<{kind: 'settled' | 'continue'; state: StoreState; maxInnerRetries: number; innerRetriesUsed: number}> {
  if (!roles.size) roles = buildRoleRegistry(agentsDir);
  await executeIteration(sorted, project, run, directory, workflow, adapter, agents, agentsDir, roles, injected, skills, task, availableSkills, clock);
  state = readRunState(project, run);
  return { kind: isPausedRunStatus(state.status) || isTerminalRunStatus(state.status) ? 'settled' : 'continue', state,
    maxInnerRetries: state.decisionGraph?.maxVisits ?? Math.max(0, Math.floor(state.maxRetries ?? loadDefaults().gate_retry_loops)),
    innerRetriesUsed: state.gateRetryRound?.iteration === iteration ? state.gateRetryRound.round : 0 };
}
