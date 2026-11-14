import { readAdmittedContract } from '../../brief-criteria.js';
import { rethrowGitNotAnswered } from '../../git-facts.js';
import { RESEARCH_PROTOCOL } from '../../research-instrument.js';
import { adapterInputLimit } from '../../adapter-input.js';
import { parseBriefFrontmatter, declarationConfiguration } from '../sched_admission/brief-contract.js';
import { runResearchLoop, researchStages } from '../sched_policy/research.js';
// Boundary: Manage admitted run lifetime, verified checkpoint, heartbeat, deterministic watchdog and unconditional owned cleanup around the iteration driver.
import { Adapter, AgentConfig, withRunProcessOwnership } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { admittedContract, type BriefAdmissionRecord } from '../../brief-preflight.js';
import { captureEngineCheckpoint } from '../../restart-recovery.js';
import { invalidateRunLockCache, releaseLaunchIntent } from '../../run-lock.js';
import { SchedulerHeartbeatHandle, startSchedulerHeartbeat } from '../../scheduler-heartbeat.js';
import { WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { applyBasePrompt, buildRoleRegistry, listAvailableSkills, loadBasePrompt } from '../sched_admission/dispatch.js';
import { log } from '../sched_admission/shared.js';
import { removeSchedulerPidIfOwned } from '../sched_policy/identity.js';
import { bindFrozenInputs } from '../sched_scope/frozen-inputs.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, readStageStatus, readRunReservation, runDir, updateRunState } from '../../store.js';
import { StageWatchdog } from '../../stage-watchdog.js';
import { configureWorkflowBrief } from './brief.js';
import { prepareWorkflowLaunch } from './launch.js';
import { runWorkflowIterations } from './workflow-loop.js';
import { writeCampaignEntry } from './services.js';
import { concludeRun, reconcileResearchConclusion } from '../sched_policy/run-completion.js';
import { join } from 'node:path';
import { engineConfigDir } from '../../config.js';
import { recordRunEvent } from '../../run-events.js';
import { SINGLE_AUTHOR_NOTICE } from '../sched_policy/prompt-contracts.js';
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
  _legacyAutoApprove?: boolean,
  campaignId?: string,
  briefAdmission?: BriefAdmissionRecord,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<StoreState> {
  const reservation = existingRunId ? readRunReservation(projectDir, existingRunId) : undefined;
  const frozen = existingRunId && (!reservation || reservation.briefAdmission)
    ? reservation?.briefAdmission ? admittedContract(reservation.briefAdmission) : readAdmittedContract(runDir(projectDir, existingRunId)) : undefined;
  const declared = frozen ? declarationConfiguration(frozen.declaration)
    : parseBriefFrontmatter(taskDescription ?? '');
  if (declared?.research) workflow = { ...workflow, name: 'research', stages: researchStages(declared.research), dispatch: undefined };
  let launch;
  try { launch = prepareWorkflowLaunch(workflow, workflowYaml, projectDir, existingRunId, taskDescription, briefAdmission, adapterInputLimit(adapter)); }
  catch (error) {
    rethrowGitNotAnswered(error);
    const reason = error instanceof Error ? error.message : String(error);
    const policyRefusal = reason.startsWith('Deployment hold is active') || reason.startsWith('Cannot resume: iteration budget exhausted');
    if (existingRunId && !policyRefusal) recordContinuationRefusal(projectDir, existingRunId, reason);
    throw error;
  }
  if (launch.kind === 'settled') {
    return launch.state.research?.protocol === RESEARCH_PROTOCOL ? reconcileResearchConclusion(projectDir, launch.state.runId) : launch.state;
  }
  const {runId, runDirPath, maxIterations: initialMaxIterations, baseStages, resumingExistingRun, resumeAtIteration, schedulerPidPath, launchIntentOwned} = launch;
  const maxIterations = initialMaxIterations;
  workflowYaml = launch.workflowYaml;
  // Watchdog and pid cleanup cover every return after admission, including
  // brief/frontmatter validation failures before the iteration loop.
  let settled: StoreState | undefined;
  let watchdog: StageWatchdog | undefined;
  let schedulerHeartbeat: SchedulerHeartbeatHandle | undefined;
  return withRunProcessOwnership(projectDir, runId, async () => {
  try {
  const checkpointState = updateRunState(projectDir, runId, (state) => {
    if (state.status === RUN_STATUS.CANCELLED) return;
    state.engineCheckpoint = captureEngineCheckpoint(projectDir, runId);
    const checkpoint = state.engineCheckpoint;
    state.engineHistory ??= [];
    state.engineHistory.push({ kind: resumingExistingRun ? 'resume' : 'start', at: checkpoint.at,
      generation: checkpoint.generation, pid: checkpoint.pid, processStart: checkpoint.processStart });
    if (state.recovery?.kind === 'resumable') state.recovery.kind = 'resuming';
  });
  if (checkpointState.status === RUN_STATUS.CANCELLED) return settled = checkpointState;
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
  log.info({ runId }, SINGLE_AUTHOR_NOTICE);
  recordRunEvent(projectDir, runId, { type: 'execution_notice', runId, timestamp: new Date().toISOString(), detail: SINGLE_AUTHOR_NOTICE, source: 'scheduler' });
  const configured = configureWorkflowBrief(workflow, projectDir, runId, runDirPath, maxIterations, { resumingExistingRun, briefWasAdmitted: launch.briefWasAdmitted }, taskDescription, campaignId, briefAdmission);
  if (configured.kind === 'settled') return settled = configured.state;
  bindFrozenInputs(projectDir, runDirPath);
  taskDescription = configured.taskDescription;
  const researchState = configured.researchState ?? checkpointState;
  const research = researchState.research;

  const resolvedAgentsDir = agentsDir ?? join(engineConfigDir, 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const availableSkillsList = listAvailableSkills(projectDir);

  watchdog = new StageWatchdog(projectDir, runId, { idleThresholdMs: heartbeatDefaults.stage_idle_timeout_ms });
  watchdog.start();
  if (research) return settled = await runResearchLoop(projectDir, runId, runDirPath, workflow, adapter, agents,
    resolvedAgentsDir, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  return settled = await runWorkflowIterations(baseStages, workflowYaml, maxIterations, resumeAtIteration, resumingExistingRun, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, roleRegistry, skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory);
  } catch (error) {
    rethrowGitNotAnswered(error);
    const reason = `Scheduler failed: ${error instanceof Error ? error.message : String(error)}`;
    log.error({ err: error }, reason);
    let publish: ((persist: () => void) => void) | undefined;
    settled = updateRunState(projectDir, runId, state => {
      if (state.status !== RUN_STATUS.RUNNING) return;
      const completedAt = new Date().toISOString();
      for (const [id, stage] of Object.entries(state.stages)) {
        if (stage.status !== STAGE_STATUS.RUNNING) continue;
        try {
          const closed = readStageStatus(projectDir, runId, id);
          if (closed.status === STAGE_STATUS.COMPLETE) { state.stages[id] = closed; continue; }
        } catch { /* a pre-worker failure has no settled attempt */ }
        stage.status = STAGE_STATUS.FAILED;
        stage.error = reason;
        stage.completedAt = completedAt;
      }
      concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'scheduler_failed', detail: reason,
        eventFields: () => ({ iteration: state.currentIteration, detail: reason }), writeCampaignEntry },
      (_state, notify) => { publish = notify; });
    }, (_current, persist) => {
      if (publish) publish(persist);
    });
    return settled;
  } finally {
    // Complete research bookkeeping while this scheduler still owns the run.
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
