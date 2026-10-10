// Boundary: Validate declared launch inputs and claim one run/project owner; preserves cancellation and park/resume transactions before execution.
import { artifactDeclarationErrors } from '../../artifact-declarations.js';
import { writeBriefCriteriaArtifact } from '../../brief-criteria.js';
import { BriefAdmissionRecord, verifyBriefAdmission } from '../../brief-preflight.js';
import { resolveRunIdentity } from '../../cancellation-policy.js';
import { engineGeneration, reconcileHostInterruptedRun } from '../../restart-recovery.js';
import { claimLaunchIntent, describeLiveRunOwner, findLiveRunOwnerForProject, inspectRunScheduler, invalidateRunLockCache, releaseLaunchIntent } from '../../run-lock.js';
import { StageConfig, WorkflowConfig, loadDefaults, normalizeRetryGateRelationships } from '../sched_admission/configuration.js';
import { topoSort } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { claimSchedulerPid, removeSchedulerPidIfOwned } from '../sched_policy/identity.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';
import { snapshotShipSetupValidationBaseline } from '../sched_settlement/gate-validation.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, initializeReservedRun, isPausedRunStatus, readRunReservation, readRunState, requireKnownRunStatus, reserveRun, runDir, runsRoot, updateRunState, writeRunState } from '../../store.js';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

export function prepareWorkflowLaunch(
  workflow: WorkflowConfig, workflowYaml: string, projectDir: string,
  existingRunId?: string, taskDescription?: string, briefAdmission?: BriefAdmissionRecord,
): { kind: 'settled'; state: StoreState } | {
  kind: 'ready'; runId: string; runDirPath: string; launchIntentOwned: boolean;
  maxIterations: number; baseStages: StageConfig[]; workflowYaml: string;
  resumingFromPark: boolean; resumeAtIteration: number; schedulerPidPath: string;
} {
  const declarationErrors = workflow.stages.flatMap((stage) => artifactDeclarationErrors(stage.artifact_contract, stage.id));
  if (declarationErrors.length) throw new Error(`DECLARED_INPUT_MIGRATION_REQUIRED: this generation cannot launch or resume legacy inputs; declare each stage artifact_contract and replays, or finish under its admitted generation. ${declarationErrors.join('; ')}`);
  if (briefAdmission) {
    if (taskDescription === undefined) {
      throw new Error('A brief admission record was supplied without the exact brief text');
    }
    const verification = verifyBriefAdmission(taskDescription, briefAdmission);
    if (verification.status !== 'valid') {
      throw new Error(
        `Brief admission ${verification.status}; scheduler launch stopped before run creation `
        + `(current digest ${verification.report.digest.slice(0, 12)}).`,
      );
    }
  }
  normalizeRetryGateRelationships(workflow.stages);
  // The run-local workflow is the normalized executable contract, including
  // inferred gate/dependency facts, not the stale input text.
  workflowYaml = stringifyYaml(workflow);
  const baseStages = topoSort(workflow.stages);
  const stageIds = baseStages.map((s) => s.id);
  let maxIterations = workflow.defaults.max_iterations ?? loadDefaults(projectDir).max_iterations;

  let runId: string;
  let runDirPath: string;
  let launchIntentOwned: boolean;
  // Set when this launch is RESUMING a parked run rather than relaunching a
  // finished one: the loop then continues the park's own iteration instead of
  // restarting at 1 with a fresh budget.
  let resumingFromPark = false;
  let resumeAtIteration = 1;
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
      // createRun prepares a running projection before dispatch. Every consumer
      // gets a durable attempt before launch; an untouched preparation is not an
      // interrupted execution. Every interrupted execution needs current proof;
      // an earlier recovery does not authorize a later checkpoint or crash.
      const dispatched = archived.engineCheckpoint || Object.values(archived.stages).some(stage => stage.status === STAGE_STATUS.RUNNING || (stage.attempts?.length ?? 0) > 0);
      if (archived.status === RUN_STATUS.RUNNING && dispatched) {
        const owner = inspectRunScheduler(runId, runDirPath);
        if (owner.kind !== 'dead' && owner.kind !== 'missing' && owner.kind !== 'reused') throw new Error(`RECOVERY_FATE_UNKNOWN: scheduler identity is ${owner.kind}; exclude a live or unverifiable owner before reconciliation`);
        archived = reconcileHostInterruptedRun(projectDir, runId);
      }
      // User cancellation is authoritative for this run. Return before launch
      // claims, signal cleanup, workflow resets or any new execution; further
      // work requires a new run, including when recovery observed cancellation.
      if (archived.status === RUN_STATUS.STOPPED) return { kind: 'settled', state: archived };
      if (archived.recovery?.kind === 'blocked') throw new Error(archived.recovery.reason);
      if (archived.recovery?.kind === 'resumable' && archived.engineCheckpoint?.generation !== engineGeneration()) throw new Error('RECOVERY_GENERATION_MISMATCH: load the interrupted run\'s verified generation before resuming');
    }
    let launchClaim: ReturnType<typeof claimLaunchIntent>;
    try { launchClaim = claimLaunchIntent(projectDir, runId); }
    catch (error) {
      if (readRunState(projectDir, runId).status === RUN_STATUS.STOPPED) return { kind: 'settled', state: readRunState(projectDir, runId) };
      throw error;
    }
    if (!launchClaim.claimed) {
      if (hasRunState) return { kind: 'settled', state: readRunState(projectDir, runId) };
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const blocked = readRunState(projectDir, runId);
      if (taskDescription) blocked.taskDescription = taskDescription;
      if (briefAdmission) blocked.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      blocked.status = 'failed';
      blocked.failureReason = `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.`;
      blocked.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, blocked);
      return { kind: 'settled', state: blocked };
    }
    launchIntentOwned = true;
    if (reservation) {
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const state = readRunState(projectDir, runId);
      state.maxIterations = maxIterations;
      state.currentIteration = 1;
      state.timeoutMs = loadDefaults(projectDir).timeout_ms;
      if (taskDescription) state.taskDescription = taskDescription;
      if (briefAdmission) state.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      writeRunState(projectDir, runId, state);
    }
    const prepared = updateRunState(projectDir, runId, (state) => {
    if (state.status === RUN_STATUS.STOPPED) return;
    mkdirSync(join(runDirPath, 'stages'), { recursive: true });
    for (const s of baseStages) {
      mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
    }
    maxIterations = state.maxIterations ?? maxIterations;
    // RESUMING a park is not RELAUNCHING a finished run. A resume continues the
    // same run — same iteration budget, same lifecycle clock, same signals — so
    // it must skip the hygiene below. Applying it to a park would (a) hand back
    // a full fresh iteration budget on every park cycle, (b) reset startedAt and
    // thereby make tryAdvanceResearch discard the round measured just before the
    // park as "stale", and (c) delete signals/ mid-flight.
    resumingFromPark = isPausedRunStatus(state.status);
    if (!resumingFromPark) for (const s of baseStages) {
      if (!state.stages[s.id]) state.stages[s.id] = { status: 'pending', retries: 0 };
    }
    if (resumingFromPark) {
      resumeAtIteration = state.parked?.atIteration ?? state.currentIteration ?? 1;
    }
    if (briefAdmission) {
      state.briefAdmission = briefAdmission;
    }
    if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
      writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
    }
    if (!resumingFromPark && !reservation) {
      state.status = 'running';
      state.workflowName = workflow.name;
      state.maxIterations = maxIterations;
      state.timeoutMs = loadDefaults(projectDir).timeout_ms;
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
      delete state.terminalArtifact;
      try { rmSync(join(runDirPath, 'signals'), { recursive: true, force: true }); } catch { /* best effort */ }
      // Reset the integrity-rejection tally so a prior run's rejections don't shrink
      // this rerun's budget.
      try { unlinkSync(join(runDirPath, 'research_integrity_rejections.json')); } catch { /* best effort */ }
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }
    });
    if (prepared.status === RUN_STATUS.STOPPED) {
      releaseLaunchIntent(projectDir, runId);
      return { kind: 'settled', state: prepared };
    }
  } else {
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
      state.status = 'failed';
      state.failureReason = `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      return { kind: 'settled', state };
    }
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    state.timeoutMs = loadDefaults(projectDir).timeout_ms;
    writeRunState(projectDir, runId, state);
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
    if (state.status !== RUN_STATUS.STOPPED) schedulerClaimed = claimSchedulerPid(schedulerPidPath, runId);
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
  if (!resumingFromPark && launchIntentOwned) {
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
    if (resumingFromPark) {
      // Approval remains consumed in the append log, but the run itself must
      // stay resumable. Do not erase parked metadata or manufacture a failure.
      log.warn({ runId, sibling: siblingDescription, projectDir }, 'Resume deferred: another active run exists for this project');
      if (launchIntentOwned) {
        releaseLaunchIntent(projectDir, runId);
        invalidateRunLockCache();
      }
      return { kind: 'settled', state };
    }
    state.status = 'failed';
    state.failureReason = `Single-in-flight: another active run (${siblingDescription}) exists for this project. Stop it first or wait for it to finish.`;
    state.completedAt = new Date().toISOString();
    writeRunState(projectDir, runId, state);
    log.error({ runId, sibling: siblingDescription, projectDir }, 'Refusing to start: another active run exists for this project');
    return { kind: 'settled', state };
  }

  // Admission succeeded: only now consume the parked lifecycle marker.
  if (resumingFromPark) {
    let resumed = false;
    const state = updateRunState(projectDir, runId, (current) => {
      if (!isPausedRunStatus(current.status)) return;
      current.status = 'running';
      current.workflowName = workflow.name;
      current.maxIterations = maxIterations;
      current.timeoutMs = loadDefaults(projectDir).timeout_ms;
      current.currentIteration = resumeAtIteration;
      for (const stage of baseStages) {
        if (!current.stages[stage.id]) current.stages[stage.id] = { status: 'pending', retries: 0 };
      }
      delete current.parked;
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
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
  return {kind: 'ready', runId, runDirPath, launchIntentOwned, maxIterations, baseStages, workflowYaml, resumingFromPark, resumeAtIteration, schedulerPidPath};
}
