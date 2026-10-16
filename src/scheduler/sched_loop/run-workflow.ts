// Boundary: Manage admitted run lifetime, verified checkpoint, heartbeat, deterministic watchdog and unconditional owned cleanup around the iteration driver.
import { Adapter, AgentConfig, withRunProcessOwnership } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { BriefAdmissionRecord } from '../../brief-preflight.js';
import { captureEngineCheckpoint } from '../../restart-recovery.js';
import { invalidateRunLockCache, releaseLaunchIntent } from '../../run-lock.js';
import { SchedulerHeartbeatHandle, startSchedulerHeartbeat } from '../../scheduler-heartbeat.js';
import { WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { applyBasePrompt, buildRoleRegistry, listAvailableSkills, loadBasePrompt } from '../sched_admission/dispatch.js';
import { log } from '../sched_admission/shared.js';
import { removeSchedulerPidIfOwned } from '../sched_policy/identity.js';
import { closeRollbackBaseline } from '../sched_scope/rollback-baseline.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, updateRunState } from '../../store.js';
import { StageWatchdog } from '../../stage-watchdog.js';
import { configureWorkflowBrief } from './brief.js';
import { prepareWorkflowLaunch } from './launch.js';
import { runWorkflowIterations } from './workflow-loop.js';
import { publishRunCompletion } from './iteration-outcome.js';
import { settleTerminalResearchCandidates } from '../sched_policy/run-completion.js';
import { join } from 'node:path';
import { engineConfigDir } from '../../config.js';
import { recordContinuationRefusal } from '../../engine-continuation.js';

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
  campaignId?: string,
  inheritCampaignContext: boolean = true,
  briefAdmission?: BriefAdmissionRecord,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<StoreState> {
  let launch;
  try { launch = prepareWorkflowLaunch(workflow, workflowYaml, projectDir, existingRunId, taskDescription, briefAdmission); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const policyRefusal = reason.startsWith('Deployment hold is active') || reason.startsWith('Cannot resume: iteration budget exhausted');
    if (existingRunId && !policyRefusal) recordContinuationRefusal(projectDir, existingRunId, reason);
    throw error;
  }
  if (launch.kind === 'settled') {
    settleTerminalResearchCandidates(projectDir, launch.state);
    return launch.state;
  }
  const {runId, runDirPath, maxIterations, baseStages, resumingExistingRun, resumeAtIteration, schedulerPidPath, launchIntentOwned} = launch;
  workflowYaml = launch.workflowYaml;
  // Watchdog and pid cleanup cover every return after admission, including
  // brief/frontmatter validation failures before the iteration loop.
  let settled: StoreState | undefined;
  let watchdog: StageWatchdog | undefined;
  let schedulerHeartbeat: SchedulerHeartbeatHandle | undefined;
  return withRunProcessOwnership(projectDir, runId, async () => {
  try {
  const checkpointState = updateRunState(projectDir, runId, (state) => {
    if (state.status === RUN_STATUS.STOPPED) return;
    state.engineCheckpoint = captureEngineCheckpoint(projectDir, runId);
    const checkpoint = state.engineCheckpoint;
    state.engineHistory ??= [];
    state.engineHistory.push({ kind: resumingExistingRun ? 'resume' : 'start', at: checkpoint.at,
      generation: checkpoint.generation, pid: checkpoint.pid, processStart: checkpoint.processStart });
    if (state.recovery?.kind === 'resumable') state.recovery.kind = 'resuming';
  });
  if (checkpointState.status === RUN_STATUS.STOPPED) return settled = checkpointState;
  const heartbeatDefaults = loadDefaults();
  schedulerHeartbeat = startSchedulerHeartbeat({
    runPath: runDirPath,
    runId,
    intervalMs: heartbeatDefaults.scheduler_heartbeat_interval_ms,
    stallThresholdMs: heartbeatDefaults.scheduler_stall_threshold_ms,
    observerPollMs: heartbeatDefaults.scheduler_stall_observer_poll_ms,
  });
  await schedulerHeartbeat.ready.catch((err) => log.warn({ err }, 'Scheduler observer unavailable'));
  log.info({ runId, workflow: workflow.name }, 'Run started');
  const configured = configureWorkflowBrief(workflow, projectDir, runId, runDirPath, maxIterations, resumingExistingRun, taskDescription, autoApprove, campaignId, inheritCampaignContext, briefAdmission);
  if (configured.kind === 'settled') return settled = configured.state;
  taskDescription = configured.taskDescription;

  const resolvedAgentsDir = agentsDir ?? join(engineConfigDir, 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const availableSkillsList = listAvailableSkills(projectDir);

  watchdog = new StageWatchdog(projectDir, runId, { idleThresholdMs: heartbeatDefaults.stage_idle_timeout_ms });
  watchdog.start();
  return settled = await runWorkflowIterations(baseStages, workflowYaml, maxIterations, resumeAtIteration, resumingExistingRun, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  } catch (error) {
    const reason = `Scheduler failed: ${error instanceof Error ? error.message : String(error)}`;
    log.error({ err: error }, reason);
    settled = updateRunState(projectDir, runId, state => {
      if (state.status !== RUN_STATUS.RUNNING) return;
      state.status = RUN_STATUS.FAILED;
      state.failureReason = reason;
      state.completedAt = new Date().toISOString();
      for (const stage of Object.values(state.stages)) {
        if (stage.status !== STAGE_STATUS.RUNNING) continue;
        stage.status = STAGE_STATUS.FAILED;
        stage.error = reason;
        stage.completedAt = state.completedAt;
      }
    });
    if (settled.status === RUN_STATUS.FAILED && settled.failureReason === reason) {
      const failed = settled;
      publishRunCompletion(failed, projectDir, runId, () => ({ iteration: failed.currentIteration, detail: reason }));
    }
    return settled;
  } finally {
    // Complete research bookkeeping while this scheduler still owns the run.
    settleTerminalResearchCandidates(projectDir, settled);
    closeRollbackBaseline(projectDir, runDirPath);
    await schedulerHeartbeat?.stop();
    watchdog?.stop();
    removeSchedulerPidIfOwned(schedulerPidPath);
    if (launchIntentOwned) {
      releaseLaunchIntent(projectDir, runId);
      invalidateRunLockCache();
    }
  }
  });
}

