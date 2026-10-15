import { runStageWave } from '../stage-wave.js';
import { bindReviewedGateValidation, recordGateValidationDelta } from '../sched_settlement/gate-validation.js';
// Boundary: Run admitted disjoint batches, coordinate existing approval/revision monitors, settle audits, suspension and thrown attempts; stage execution is a supplied callback.
import { StageAttemptSettlementError, STAGE_STATUS, type StoreState, type AttemptAttribution, readRunState, readStageStatus, runDir, type StageStatus, completeStageAttempt, isPausedRunStatus, writeRunState } from "../../store.js";
import { join } from "node:path";
import { attemptEventFields, recordRunEvent, recordStageOutcome } from "../../run-events.js";
import { log } from "../sched_admission/shared.js";
import { type RunResult } from '../../adapters/base.js';
import { type LiveConstraintGuardFactory } from "../../live-constraint-guard.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { detectParallelWriteConflicts, isStageInSkippedBranch, selectRunnableBatch } from "../sched_admission/frontier.js";
import { type RepairRoundSnapshot } from './snapshots.js';
import { type ScopeBatchContext, createScopeBatchContext } from './scope-batch.js';
import { acceptedInheritedScope, stageWithInheritedScope } from './scope-revisions.js';
import { type createApprovalMonitor } from "../sched_policy/approvals.js";
import { type createScopeRevisionMonitor } from './revision-monitor.js';
import { type createLiveGuardFactory } from './write-enforcement.js';
import { type createScopeReconciler } from './reconciliation.js';

export function allDone(state: StoreState, stages: StageConfig[]): boolean {
  const stagesById = new Map(stages.map(stage => [stage.id, stage]));
  return Object.entries(state.stages).every(
    // A skip is a terminal disposition for whole-DAG settlement, but it is not
    // successful production and therefore cannot satisfy a dependency.
    ([id, s]) => s.status === STAGE_STATUS.COMPLETE || s.status === STAGE_STATUS.SKIPPED
      || isStageInSkippedBranch(id, stagesById, state),
  );
}

export function anyFailed(state: StoreState): boolean {
  return Object.values(state.stages).some((s) => s.status === STAGE_STATUS.FAILED);
}

/**
 * A scheduler-owned failure can happen before `runStage` starts (for example,
 * while loading a late-bound role) or while an adapter call is throwing.  In
 * either case the worker cannot publish its normal attempt-failed event.  Keep
 * the stage ledger and the canonical event feed in lock-step before the error
 * is propagated or converted into the ordinary retry/failure path.
 */
export function recordThrownStageAttempt(
  projectDir: string,
  runId: string,
  stageId: string,
  retries: number,
  error: unknown,
  attribution?: AttemptAttribution,
): StageStatus | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    let existing: StageStatus | undefined;
    try { existing = readStageStatus(projectDir, runId, stageId); } catch { /* pre-worker failure has no ledger yet */ }
    // The worker publishes reconciliation failures before propagating them.
    if (error instanceof StageAttemptSettlementError && error.stageId === stageId
        && existing?.attempts?.at(-1)?.index === error.attemptIndex
        && existing.attempts.at(-1)?.status === STAGE_STATUS.FAILED) return existing;
    const final = completeStageAttempt(projectDir, runId, stageId, retries, {
      attribution,
      exitCode: 1,
      duration_ms: 0,
      error: detail,
      writeAttribution: 'unknown',
    });
    const attempt = final.attempts?.at(-1);
    recordRunEvent(projectDir, runId, {
      type: 'attempt_failed',
      runId,
      timestamp: attempt?.completedAt ?? new Date().toISOString(),
      stageId,
      ...attemptEventFields(attempt),
      status: STAGE_STATUS.FAILED,
      detail,
      source: 'scheduler',
      level: 'warning',
    });
    return final;
  } catch (recordingError) {
    log.error({ stage: stageId, err: recordingError }, 'Could not record thrown stage attempt');
    return undefined;
  }
}

/** Re-sync run.json stage entries from individual status.json files after parallel execution. */
export function syncStageStatuses(projectDir: string, runId: string, stageIds: string[]): void {
  const state = readRunState(projectDir, runId);
  for (const sid of stageIds) {
    try { state.stages[sid] = readStageStatus(projectDir, runId, sid); } catch { /* keep existing */ }
  }
  writeRunState(projectDir, runId, state);
}

interface ScopeSafeStageServices {
  monitorApprovalRequests: ReturnType<typeof createApprovalMonitor>['monitorApprovalRequests'];
  monitorScopeRevisionRequests: ReturnType<typeof createScopeRevisionMonitor>['monitorScopeRevisionRequests'];
  createSchedulerLiveConstraintGuardFactory: ReturnType<typeof createLiveGuardFactory>['createSchedulerLiveConstraintGuardFactory'];
  reconcileCompletedStageAttempts: ReturnType<typeof createScopeReconciler>['reconcileCompletedStageAttempts'];
}

/** One policy boundary flushes request authority before verification and audits closure afterward. */
export function createStageSettlementBoundary(input: {
  stage: StageConfig; selected: StageConfig[]; activeStageIds: Set<string>;
  projectDir: string; runId: string; context: ScopeBatchContext;
}, services: Pick<ScopeSafeStageServices, 'monitorScopeRevisionRequests' | 'reconcileCompletedStageAttempts'>): (phase: 'child_closed' | 'attempt_closed') => Promise<boolean> {
  return async phase => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await services.monitorScopeRevisionRequests({ ...input, completion: AbortSignal.abort() });
    const attempt = readStageStatus(input.projectDir, input.runId, input.stage.id).attempts?.at(-1);
    if (phase === 'child_closed') return attempt !== undefined && input.context.attempt(input.stage.id, attempt.index).acceptedDuringAttempt;
    const reconciled = services.reconcileCompletedStageAttempts(input);
    return !reconciled.violation && reconciled.acceptedRevisionDuringAttempt
      && reconciled.attemptIndex === attempt?.index && attempt?.exitCode === 0;
  };
}

/** Re-admit inherited paths against peers before starting another child. */
export function readmitScopeContinuation(
  stage: StageConfig, selected: StageConfig[], activeStageIds: Set<string>, runDirPath: string, context: ScopeBatchContext,
): StageConfig | undefined {
  const revised = stageWithInheritedScope(runDirPath, stage);
  const peers = selected.filter((peer) => peer.id !== stage.id && activeStageIds.has(peer.id))
    .map((peer) => stageWithInheritedScope(runDirPath, peer));
  const admission = selectRunnableBatch([...peers, revised]);
  if (admission.deferred.some((entry) => entry.stage.id === revised.id)) return undefined;
  // Keep the shared frozen preimages and peer attribution. Only the next
  // attempt's capability changes; old attempt records remain immutable.
  const inherited = acceptedInheritedScope(runDirPath, stage);
  context.inherit(stage.id, inherited);
  return revised;
}

export function createScopeSafeStageRunner(services: ScopeSafeStageServices) {
  const { monitorApprovalRequests, monitorScopeRevisionRequests, createSchedulerLiveConstraintGuardFactory } = services;

  async function runScopeSafeStageGroup(
    stages: StageConfig[],
    projectDir: string,
    runId: string,
    iteration: number,
    execute: (stage: StageConfig, liveConstraintGuardFactory?: LiveConstraintGuardFactory, settlementBoundary?: (phase: 'child_closed' | 'attempt_closed') => Promise<boolean>) => Promise<RunResult | void>,
    snapshot?: RepairRoundSnapshot,
  ): Promise<void> {
    const runDirPath = runDir(projectDir, runId);
    const declaredStageById = new Map(stages.map((stage) => [stage.id, stage]));
    let pending = stages.map((stage) => stageWithInheritedScope(runDirPath, stage));
    while (pending.length > 0) {
      const { selected, deferred } = selectRunnableBatch(pending);
      for (const { stage, conflict } of deferred) {
        const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
        log.info({ stage: stage.id, conflict }, 'Serializing retry/gate stage because declared scopes are not provably disjoint');
        recordRunEvent(projectDir, runId, {
          type: 'parallel_scope_serialized', runId, timestamp: new Date().toISOString(),
          iteration, stageId: stage.id, stageIds: [conflict.leftStageId, conflict.rightStageId],
          level: 'info', detail,
        });
      }
      const context = createScopeBatchContext(
        projectDir,
        selected.map((stage) => declaredStageById.get(stage.id) ?? stage),
        snapshot,
        runId,
      );
      const activeStageIds = context.activeStageIds;
      const redispatch: StageConfig[] = [];
      const wave = await runStageWave(selected, {
        activeStageIds,
        monitorScope: (completion) => monitorScopeRevisionRequests({ selected, activeStageIds, projectDir, runId, context, completion }),
        monitorApproval: (completion) => monitorApprovalRequests({ selected, projectDir, runId, runDirPath, iteration, completion }),
        execute: async (initialStage) => {
        let stage = initialStage;
        let result: RunResult | void = undefined;
        try {
          while (true) {
            result = await execute(stage, createSchedulerLiveConstraintGuardFactory({ stage, projectDir, runId, context }), createStageSettlementBoundary({ stage, selected, activeStageIds, projectDir, runId, context }, services));
            if (!result?.suspended) break;
            if (isPausedRunStatus(readRunState(projectDir, runId).status)) break;
            const next = readmitScopeContinuation(stage, selected, activeStageIds, runDirPath, context);
            if (!next) { redispatch.push(stageWithInheritedScope(runDirPath, stage)); break; }
            stage = next;
          }
        }
        catch (error) {
          const retries = (() => {
            try { return readStageStatus(projectDir, runId, stage.id).retries; }
            catch { return 0; }
          })();
          recordThrownStageAttempt(projectDir, runId, stage.id, retries, error, { role: stage.role, iteration });
          throw error;
        }
        },
      });
      const executionError = wave.results.find((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (executionError) throw executionError.reason;
      const parkedDuringExecution = wave.parked;
      // Let recursive filesystem notifications queued by a synchronous adapter
      // reach the run-scoped journal before reconciliation reads its cursor.
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      for (const stage of selected) {
        const finalStatus = readStageStatus(projectDir, runId, stage.id);
        if (finalStatus.status === STAGE_STATUS.COMPLETE || finalStatus.status === STAGE_STATUS.FAILED) {
          if (stage.is_gate && !bindReviewedGateValidation(projectDir, runId, stage.id, selected.map(peer => peer.id))) {
            await recordGateValidationDelta(projectDir, runId, stage.id);
          }
          recordStageOutcome(projectDir, runId, stage.id, iteration, finalStatus);
        }
      }
      if (parkedDuringExecution || isPausedRunStatus(readRunState(projectDir, runId).status)) {
        syncStageStatuses(projectDir, runId, selected.map((stage) => stage.id));
        return;
      }
      const statuses: Record<string, StageStatus> = {};
      for (const stage of selected) {
        try { statuses[stage.id] = readStageStatus(projectDir, runId, stage.id); } catch { /* missing status */ }
      }
      for (const conflict of detectParallelWriteConflicts(selected.map((stage) => stage.id), statuses)) {
        const detail = `${conflict.stageIds[0]} and ${conflict.stageIds[1]} both wrote ${conflict.files.join(', ')} (attribution: ${conflict.attribution.join(' / ')})`;
        log.warn({ conflict }, 'Parallel retry/gate stages wrote the same file');
        recordRunEvent(projectDir, runId, {
          type: 'parallel_write_conflict', runId, timestamp: new Date().toISOString(), iteration,
          stageIds: conflict.stageIds, files: conflict.files, level: 'warning', detail,
        });
      }
      pending = [...redispatch, ...deferred.map(({ stage }) => stage)];
    }
  }

  return { runScopeSafeStageGroup };
}
