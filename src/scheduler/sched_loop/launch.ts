import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Validate declared launch inputs and claim one run/project owner; preserves cancellation and park/resume transactions before execution.
import { writeBriefCriteriaArtifact } from '../../brief-criteria.js';
import { BriefAdmissionRecord, verifyBriefAdmission } from '../../brief-preflight.js';
import { resolveRunIdentity } from '../../cancellation-policy.js';
import { reconcileHostInterruptedRun } from '../../restart-recovery.js';
import { claimLaunchIntent, describeLiveRunOwner, findLiveRunOwnerForProject, inspectRunScheduler, invalidateRunLockCache, releaseLaunchIntent } from '../../run-lock.js';
import { StageConfig, WorkflowConfig, loadDefaults, normalizeStageContracts, RecordedWorkflowConfigSchema } from '../sched_admission/configuration.js';
import { topoSort } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { claimSchedulerPid, removeSchedulerPidIfOwned } from '../sched_policy/identity.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';
import { snapshotShipSetupValidationBaseline } from '../sched_settlement/gate-validation.js';
import { collectGateRuntimeFacts } from '../sched_settlement/gate-recovery.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, isContinuingStage, initializeReservedRun, isPausedRunStatus, isResumableRunStatus, readRunReservation, readRunState, rependStageStatus, requireKnownRunStatus, reserveRun, runDir, runsRoot, updateRunState, writeRunState } from '../../store.js';
import { atomicWrite, mkdirSync, rmSync, unlinkSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentHeld } from '../../deployment-hold.js';
import { assertContinuationCompatible } from '../../engine-continuation.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Interrupted work keeps its iteration; a settled rejection spends the next one. */
export function workflowContinuation(state: StoreState, projectDir: string, runId: string, workflow?: WorkflowConfig): { iteration: number; gateIds: string[] } {
  const currentIteration = state.parked?.atIteration ?? state.currentIteration ?? 1;
  const workflowPath = join(runDir(projectDir, runId), 'workflow.yaml');
  const admitted = workflow ?? (existsSync(workflowPath) ? RecordedWorkflowConfigSchema.parse(parseYaml(readFileSync(workflowPath, 'utf8'))) : undefined);
  const gateIds = state.status === RUN_STATUS.INCOMPLETE
    ? collectGateRuntimeFacts(state.planControl?.stages ?? admitted?.stages ?? [], state, projectDir, runId)
      .failedGateIds.filter(id => state.stages[id]?.status === STAGE_STATUS.COMPLETE)
    : [];
  const budgetContinuation = Object.values(state.stages).some(isContinuingStage);
  const iteration = currentIteration + Number(gateIds.length > 0 || budgetContinuation);
  const maxIterations = state.maxIterations ?? admitted?.defaults.max_iterations ?? loadDefaults().max_iterations;
  if (iteration > maxIterations) throw new Error(`Cannot resume: iteration budget exhausted (${currentIteration}/${maxIterations}); no admitted iteration remains.`);
  return { iteration, gateIds };
}

export function prepareWorkflowLaunch(
  workflow: WorkflowConfig, workflowYaml: string, projectDir: string,
  existingRunId?: string, taskDescription?: string, briefAdmission?: BriefAdmissionRecord,
): { kind: 'settled'; state: StoreState } | {
  kind: 'ready'; runId: string; runDirPath: string; launchIntentOwned: boolean;
  maxIterations: number; baseStages: StageConfig[]; workflowYaml: string;
  resumingExistingRun: boolean; resumeAtIteration: number; schedulerPidPath: string;
} {
  let launchState: StoreState | undefined;
  const launchUnchanged = (state: StoreState): boolean => !launchState
    || (state.status === launchState.status && state.completedAt === launchState.completedAt);
  if (existingRunId && existsSync(join(runDir(projectDir, existingRunId), 'run.json'))) {
    const archived = readRunState(projectDir, existingRunId);
    launchState = archived;
    if ((!isPausedRunStatus(archived.status) && isResumableRunStatus(archived.status))
      || archived.deploymentHold || archived.recovery?.kind === 'resumable' || (archived.status === RUN_STATUS.RUNNING && archived.engineCheckpoint)) {
      // Resume the admitted contract, validated by this engine's ordinary
      // parser, even if engine configuration changed during the redeploy.
      const admitted = RecordedWorkflowConfigSchema.parse(parseYaml(readFileSync(join(runDir(projectDir, existingRunId), 'workflow.yaml'), 'utf8')));
      for (const key of Object.keys(workflow)) Reflect.deleteProperty(workflow, key);
      Object.assign(workflow, admitted);
    }
  }
  if (workflow.name === 'default') workflow.name = 'planner';
  normalizeStageContracts(workflow.stages);
  if (briefAdmission) {
    if (taskDescription === undefined) {
      throw new Error('A brief admission record was supplied without the exact brief text');
    }
    const verification = verifyBriefAdmission(taskDescription, briefAdmission);
    if (verification.status !== 'valid') {
      throw new Error(
        `Brief admission ${verification.status}; scheduler launch stopped before run creation `
        + `(current digest ${verification.digest.slice(0, 12)}).`,
      );
    }
  }
  // The run-local workflow is the normalized executable contract, including
  // inferred gate/dependency facts, not the stale input text.
  workflowYaml = stringifyYaml(workflow);
  const baseStages = topoSort(workflow.stages);
  const stageIds = baseStages.map((s) => s.id);
  let maxIterations = workflow.defaults.max_iterations ?? loadDefaults().max_iterations;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new Error('max_iterations must be a finite positive integer');

  let runId: string;
  let runDirPath: string;
  let launchIntentOwned: boolean;
  // A continuation executes the admitted iteration with its remaining budget.
  let resumingExistingRun = false;
  let resumeAtIteration = 1;
  let gateIds: string[] = [];
  if (existingRunId) {
    const identity = resolveRunIdentity(runDir(projectDir, existingRunId), runsRoot(projectDir));
    runId = identity.runId;
    runDirPath = identity.directory;
    const hasRunState = existsSync(join(runDirPath, 'run.json'));
    const reservation = hasRunState ? undefined : readRunReservation(projectDir, runId);
    if (!hasRunState && !reservation) {
      throw new Error(`Existing run is unreadable and has no valid reservation: ${runId}`);
    }
    if (hasRunState) {
      let archived = readRunState(projectDir, runId);
      requireKnownRunStatus(archived.status, `resume run ${runId}`);
      if (!launchUnchanged(archived)) return { kind: 'settled', state: archived };
      // Run initialization prepares a running projection before dispatch. Every consumer
      // gets a durable attempt before launch; an untouched preparation is not an
      // interrupted execution. Every interrupted execution needs current proof;
      // an earlier recovery does not authorize a later checkpoint or crash.
      const dispatched = archived.engineCheckpoint || Object.values(archived.stages).some(stage => stage.status === STAGE_STATUS.RUNNING || (stage.attempts?.length ?? 0) > 0);
      if (archived.status === RUN_STATUS.RUNNING && dispatched) {
        const owner = inspectRunScheduler(runId, runDirPath);
        if (owner.kind !== 'dead' && owner.kind !== 'missing' && owner.kind !== 'reused') throw new Error(`RECOVERY_FATE_UNKNOWN: scheduler identity is ${owner.kind}; exclude a live or unverifiable owner before reconciliation`);
        archived = reconcileHostInterruptedRun(projectDir, runId);
        if (isPausedRunStatus(archived.status)) launchState = archived;
      }
      if (archived.recovery?.kind === 'blocked') throw new Error(archived.recovery.reason);
      if (!launchUnchanged(archived)) return { kind: 'settled', state: archived };
      if (isResumableRunStatus(archived.status)) {
        assertContinuationCompatible(projectDir, runId);
        ({ iteration: resumeAtIteration, gateIds } = workflowContinuation(archived, projectDir, runId, workflow));
      }
    }
    if (deploymentHeld()) throw new Error('Deployment hold is active; no scheduler may launch');
    const launchClaim = claimLaunchIntent(projectDir, runId);
    if (!launchClaim.claimed) {
      if (hasRunState) return { kind: 'settled', state: readRunState(projectDir, runId) };
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const blocked = readRunState(projectDir, runId);
      if (taskDescription) blocked.taskDescription = taskDescription;
      if (briefAdmission) blocked.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      concludeRun(blocked, { status: 'failed', reasonCode: 'launch_conflict',
        detail: `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.` });
      return { kind: 'settled', state: blocked };
    }
    launchIntentOwned = true;
    if (reservation) {
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const state = readRunState(projectDir, runId);
      state.maxIterations = maxIterations;
      state.currentIteration = 1;
      if (taskDescription) state.taskDescription = taskDescription;
      if (briefAdmission) state.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      writeRunState(projectDir, runId, state);
      launchState = state;
    }
    let preparedForLaunch = false;
    const prepared = updateRunState(projectDir, runId, (state) => {
    if (!launchUnchanged(state)) return;
    preparedForLaunch = true;
    mkdirSync(join(runDirPath, 'stages'), { recursive: true });
    for (const s of baseStages) {
      mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
    }
    maxIterations = state.maxIterations ?? maxIterations;
    // Preserve the continuation's iteration, lifecycle clock and signals.
    resumingExistingRun = isResumableRunStatus(state.status);
    if (!resumingExistingRun) for (const s of baseStages) {
      if (!state.stages[s.id]) state.stages[s.id] = { status: 'pending', retries: 0 };
    }
    if (briefAdmission && !resumingExistingRun) {
      state.briefAdmission = briefAdmission;
    }
    if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
      writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
    }
    if (!resumingExistingRun && !reservation) {
      state.status = 'running';
      state.workflowName = workflow.name;
      state.maxIterations = maxIterations;
      state.currentIteration = 1;
      // Relaunch hygiene: this run previously reached a terminal state. Refresh the
      // lifecycle markers and purge prior-run signals so we don't (a) compute a
      // stale/negative duration off the old completedAt, (b) honor a leftover
      // goal_met.json/replan.json and terminate the rerun prematurely, or (c) let
      // tryAdvanceResearch journal a stale result file from the previous run as a
      // phantom round (its freshness check keys off startedAt).
      state.startedAt = new Date().toISOString();
      delete state.completedAt;
      delete state.failureReason;
      delete state.reasonCode;
      delete state.terminalArtifact;
      try { rmSync(join(runDirPath, 'signals'), { recursive: true, force: true }); } catch { /* best effort */ }
      // Reset the integrity-rejection tally so a prior run's rejections don't shrink
      // this rerun's budget.
      try { unlinkSync(join(runDirPath, 'research_integrity_rejections.json')); } catch { /* best effort */ }
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }
    });
    if (!preparedForLaunch) {
      releaseLaunchIntent(projectDir, runId);
      return { kind: 'settled', state: prepared };
    }
    launchState = prepared;
  } else {
    if (deploymentHeld()) throw new Error('Deployment hold is active; no scheduler may launch');
    const reserved = reserveRun(projectDir);
    runId = reserved.runId;
    runDirPath = reserved.runDirPath;
    const launchClaim = claimLaunchIntent(projectDir, runId);
    launchIntentOwned = launchClaim.claimed;
    initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
    const state = readRunState(projectDir, runId);
    if (taskDescription) state.taskDescription = taskDescription;
    if (briefAdmission) state.briefAdmission = briefAdmission;
    if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
      writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
    }
    if (!launchClaim.claimed) {
      concludeRun(state, { status: 'failed', reasonCode: 'launch_conflict',
        detail: `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.` });
      return { kind: 'settled', state };
    }
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    writeRunState(projectDir, runId, state);
    launchState = state;
  }

  // Criterion transport is tied to the exact admitted brief bytes and exists
  // before a planner can emit dynamic stages.
  try {
    const briefPath = join(runDirPath, 'task_brief.md');
    const exactBrief = existsSync(briefPath)
      ? readFileSync(briefPath, 'utf-8')
      : (taskDescription ?? '');
    if (exactBrief) {
      writeBriefCriteriaArtifact(runDirPath, exactBrief);
      if (!existsSync(join(runDirPath, RUN_VALIDATION_BASELINE_FILE))) {
        snapshotShipSetupValidationBaseline(projectDir, exactBrief, runDirPath);
      }
    }
  } catch (error) {
    throw new Error(`Cannot materialize brief_criteria.json before dispatch: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  // Claim liveness before probing siblings. In particular, a parked run remains
  // durably parked during admission, but this pid makes its resume-start window
  // visible to another concurrent launcher.
  const schedulerPidPath = join(runDirPath, 'scheduler.pid');
  let schedulerClaimed = false;
  updateRunState(projectDir, runId, (state) => {
    if (launchUnchanged(state)) schedulerClaimed = claimSchedulerPid(schedulerPidPath, runId);
  });
  if (!schedulerClaimed) {
    const state = readRunState(projectDir, runId);
    if (launchIntentOwned) {
      // Another scheduler already owns the durable pid marker for this same
      // run, so the short-lived launch hand-off is no longer needed.
      releaseLaunchIntent(projectDir, runId);
      invalidateRunLockCache();
    }
    log.warn({ runId, projectDir }, 'Scheduler launch already claimed for this run');
    return { kind: 'settled', state };
  }
  if (!resumingExistingRun && launchIntentOwned) {
    // run.json is running and scheduler.pid is now live: the durable liveness
    // probe has taken over from the short launch-window intent.
    releaseLaunchIntent(projectDir, runId);
    launchIntentOwned = false;
    invalidateRunLockCache();
  }

  const sibling = findLiveRunOwnerForProject(projectDir, runId);
  if (sibling) {
    const siblingDescription = describeLiveRunOwner(sibling);
    const state = readRunState(projectDir, runId);
    removeSchedulerPidIfOwned(schedulerPidPath);
    if (resumingExistingRun) {
      // Approval remains consumed in the append log, but the run itself must
      // stay resumable. Do not erase parked metadata or manufacture a failure.
      log.warn({ runId, sibling: siblingDescription, projectDir }, 'Resume deferred: another active run exists for this project');
      if (launchIntentOwned) {
        releaseLaunchIntent(projectDir, runId);
        invalidateRunLockCache();
      }
      return { kind: 'settled', state };
    }
    concludeRun(state, { status: 'failed', reasonCode: 'launch_conflict',
      detail: `Single-in-flight: another active run (${siblingDescription}) exists for this project. Stop it first or wait for it to finish.` });
    log.error({ runId, sibling: siblingDescription, projectDir }, 'Refusing to start: another active run exists for this project');
    return { kind: 'settled', state };
  }

  // Admission succeeded: only now make unfinished work runnable again. A new
  // cancellation during admission supersedes the operator's launch snapshot.
  if (resumingExistingRun) {
    let resumed = false;
    const state = updateRunState(projectDir, runId, (current) => {
      if (!launchUnchanged(current) || !isResumableRunStatus(current.status)) return;
      for (const [stageId, status] of Object.entries(current.stages)) {
        if (status.status !== STAGE_STATUS.FAILED && status.status !== STAGE_STATUS.SKIPPED && !gateIds.includes(stageId)) continue;
        const pending = rependStageStatus(status);
        atomicWrite(join(runDirPath, 'stages', stageId, 'status.json'), JSON.stringify(pending, null, 2));
        current.stages[stageId] = pending;
      }
      current.status = 'running';
      current.workflowName = workflow.name;
      current.maxIterations = maxIterations;
      current.currentIteration = resumeAtIteration;
      if (briefAdmission) current.briefAdmission = briefAdmission;
      for (const stage of baseStages) {
        if (!current.stages[stage.id]) current.stages[stage.id] = { status: 'pending', retries: 0 };
      }
      delete current.parked;
      delete current.completedAt;
      delete current.failureReason;
      delete current.reasonCode;
      delete current.continuationFailure;
      // Release is authority for this parked continuation only, never for a
      // later failure/approval or a future manual retry of the same run.
      delete current.deploymentHold;
      // The admitted workflow already exists. A replacement parser can reorder
      // serialized defaults without changing meaning; continuation must retain
      // the original input bytes instead of republishing that normalization.
      resumed = true;
    });
    if (!resumed) {
      removeSchedulerPidIfOwned(schedulerPidPath);
      if (launchIntentOwned) releaseLaunchIntent(projectDir, runId);
      return { kind: 'settled', state };
    }
    if (launchIntentOwned) {
      releaseLaunchIntent(projectDir, runId);
      launchIntentOwned = false;
      invalidateRunLockCache();
    }
  }
  return {kind: 'ready', runId, runDirPath, launchIntentOwned, maxIterations, baseStages, workflowYaml, resumingExistingRun, resumeAtIteration, schedulerPidPath};
}
