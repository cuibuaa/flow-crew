// Boundary: Manage admitted run lifetime, verified checkpoint, heartbeat, agent/supervisor setup and unconditional owned cleanup around the iteration driver.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { loadAdapterByName } from '../../adapters/loader.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { BriefAdmissionRecord } from '../../brief-preflight.js';
import { loadSupervisorConfig } from '../../config.js';
import { captureEngineCheckpoint } from '../../restart-recovery.js';
import { invalidateRunLockCache, releaseLaunchIntent } from '../../run-lock.js';
import { SchedulerHeartbeatHandle, startSchedulerHeartbeat } from '../../scheduler-heartbeat.js';
import { WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { applyBasePrompt, buildRoleRegistry, listAvailableSkills, loadBasePrompt } from '../sched_admission/dispatch.js';
import { log } from '../sched_admission/shared.js';
import { removeSchedulerPidIfOwned } from '../sched_policy/identity.js';
import { closeRollbackBaseline } from '../sched_scope/rollback-baseline.js';
import { RUN_STATUS, StoreState, updateRunState } from '../../store.js';
import { Supervisor } from '../../supervisor.js';
import { configureWorkflowBrief } from './brief.js';
import { prepareWorkflowLaunch } from './launch.js';
import { runWorkflowIterations } from './workflow-loop.js';
import { join } from 'node:path';

export async function runWorkflow(
  workflow: WorkflowConfig,
  workflowYaml: string,
  projectDir: string,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  skills?: string,
  agentsDir?: string,
  existingRunId?: string,
  taskDescription?: string,
  autoApprove?: boolean,
  supervise?: boolean,
  campaignId?: string,
  inheritCampaignContext: boolean = true,
  briefAdmission?: BriefAdmissionRecord,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
  deferGates = false,
): Promise<StoreState> {
  const launch = prepareWorkflowLaunch(workflow, workflowYaml, projectDir, existingRunId, taskDescription, briefAdmission);
  if (launch.kind === 'settled') return launch.state;
  const {runId, runDirPath, maxIterations, baseStages, resumingFromPark, resumeAtIteration, schedulerPidPath, launchIntentOwned} = launch;
  workflowYaml = launch.workflowYaml;
  // Supervisor and pid cleanup cover every return after admission, including
  // brief/frontmatter validation failures before the iteration loop.
  let supervisor: Supervisor | undefined;
  let schedulerHeartbeat: SchedulerHeartbeatHandle | undefined;
  try {
  const checkpointState = updateRunState(projectDir, runId, (state) => {
    if (state.status === RUN_STATUS.STOPPED) return;
    if (deferGates) state.gatesDeferred = true;
    else delete state.gatesDeferred;
    state.engineCheckpoint = captureEngineCheckpoint(projectDir, runId);
    if (state.recovery?.kind === 'resumable') state.recovery.kind = 'resuming';
  });
  if (checkpointState.status === RUN_STATUS.STOPPED) return checkpointState;
  const heartbeatDefaults = loadDefaults(projectDir);
  schedulerHeartbeat = startSchedulerHeartbeat({
    runPath: runDirPath,
    runId,
    intervalMs: heartbeatDefaults.scheduler_heartbeat_interval_ms,
    stallThresholdMs: heartbeatDefaults.scheduler_stall_threshold_ms,
    observerPollMs: heartbeatDefaults.scheduler_stall_observer_poll_ms,
  });
  await schedulerHeartbeat.ready.catch((err) => log.warn({ err }, 'Scheduler observer unavailable'));
  log.info({ runId, workflow: workflow.name }, 'Run started');
  const configured = configureWorkflowBrief(workflow, projectDir, runId, runDirPath, maxIterations, resumingFromPark, taskDescription, autoApprove, supervise, campaignId, inheritCampaignContext, briefAdmission);
  if (configured.kind === 'settled') return configured.state;
  taskDescription = configured.taskDescription;

  const resolvedAgentsDir = agentsDir ?? join(projectDir, 'config', 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const availableSkillsList = listAvailableSkills(projectDir);

  // Supervisor brain: start before the iteration loop if enabled, stop in finally.
  if (supervise) {
    try {
      const supCfg = loadSupervisorConfig(projectDir);
      // loadSupervisorConfig already inherits adapter from defaults.yaml when not
      // explicitly set under supervisor:; final fallback is codex.
      const supAdapterName = supCfg.adapter || 'codex';
      const supAdapter = await loadAdapterByName(supAdapterName);
      supervisor = new Supervisor(projectDir, runId, supAdapter, supCfg, taskDescription ?? '');
      supervisor.start();
      log.info({ runId, adapter: supAdapterName, model: supCfg.model }, 'Supervisor started');
    } catch (err) {
      log.warn({ err }, 'Failed to start supervisor — continuing without it');
      supervisor = undefined;
    }
  }
  return await runWorkflowIterations(baseStages, workflowYaml, maxIterations, resumeAtIteration, resumingFromPark, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  } finally {
    closeRollbackBaseline(projectDir, runDirPath);
    await schedulerHeartbeat?.stop();
    if (supervisor) {
      try { supervisor.stop(); } catch (err) { log.warn({ err }, 'Supervisor stop failed'); }
    }
    removeSchedulerPidIfOwned(schedulerPidPath);
    if (launchIntentOwned) {
      releaseLaunchIntent(projectDir, runId);
      invalidateRunLockCache();
    }
  }
}

