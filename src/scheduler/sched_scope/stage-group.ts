import { settleGateEvaluation } from '../sched_settlement/gate-verdict.js';
import { runStageWave } from '../stage-wave.js';
import { bindReviewedGateValidation, recordGateValidationDelta, settleGateValidationEvidence } from '../sched_settlement/gate-validation.js';
// Run serialized shared-tree authors, coordinate approvals, and settle each closed attempt.
import { StageAttemptSettlementError, STAGE_STATUS, type StoreState, type AttemptAttribution, readRunState, readStageStatus, runDir, type StageStatus, completeStageAttempt, isPausedRunStatus, writeRunState } from "../../store.js";
import { attemptEventFields, recordRunEvent, recordStageOutcome } from "../../run-events.js";
import { log } from "../sched_admission/shared.js";
import { type RunResult } from '../../adapters/base.js';
import { type StageConfig } from "../sched_admission/configuration.js";
import { isStageInSkippedBranch, selectRunnableBatch } from "../sched_admission/frontier.js";
import { type RepairRoundSnapshot } from './snapshots.js';
import { type ScopeBatchContext, createScopeBatchContext } from './scope-batch.js';
import { type createApprovalMonitor } from "../sched_policy/approvals.js";
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
  reconcileCompletedStageAttempts: ReturnType<typeof createScopeReconciler>['reconcileCompletedStageAttempts'];
}

/** Settlement projects one content-contract decision after child closure. */
export function createStageSettlementBoundary(input: {
  stage: StageConfig; projectDir: string; runId: string; context: ScopeBatchContext;
}, services: Pick<ScopeSafeStageServices, 'reconcileCompletedStageAttempts'>): (phase: 'attempt_closed') => Promise<void> {
  return async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    services.reconcileCompletedStageAttempts(input);
  };
}

export function createScopeSafeStageRunner(services: ScopeSafeStageServices) {
  const { monitorApprovalRequests } = services;

  async function runScopeSafeStageGroup(
    stages: StageConfig[],
    projectDir: string,
    runId: string,
    iteration: number,
    execute: (stage: StageConfig, settlementBoundary?: (phase: 'attempt_closed') => Promise<void>) => Promise<RunResult | void>,
    repairEvidence?: RepairRoundSnapshot,
  ): Promise<void> {
    const runDirPath = runDir(projectDir, runId);
    const declaredStageById = new Map(stages.map((stage) => [stage.id, stage]));
    let pending = stages;
    const executedStages: StageConfig[] = [];
    let interrupted = false;
    while (pending.length > 0) {
      const { selected, deferred } = selectRunnableBatch(pending);
      for (const { stage, conflict } of deferred) {
        const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
        log.info({ stage: stage.id, conflict }, 'Waiting for the shared project tree owner to settle');
        recordRunEvent(projectDir, runId, {
          type: 'parallel_scope_serialized', runId, timestamp: new Date().toISOString(),
          iteration, stageId: stage.id, stageIds: [conflict.leftStageId, conflict.rightStageId],
          level: 'info', detail,
        });
      }
      const context = createScopeBatchContext(
        projectDir,
        selected.map((stage) => declaredStageById.get(stage.id) ?? stage),
        undefined,
        runId,
      );
      const wave = await runStageWave(selected, {
        monitorApproval: (completion) => monitorApprovalRequests({ selected, projectDir, runId, runDirPath, iteration, completion }),
        execute: async (initialStage) => {
        const stage = initialStage;
        try {
          await execute(stage, createStageSettlementBoundary({ stage, projectDir, runId, context }, services));
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
      executedStages.push(...selected);
      // Each serialized wave observes the preceding author's settled content.
      // Retain those captures for independent repair review,
      // preserving the earliest image when the round touched a path already.
      if (repairEvidence) {
        for (const [path, image] of context.snapshot.files) {
          if (!repairEvidence.files.has(path)) repairEvidence.files.set(path, image);
        }
        Object.assign(repairEvidence.declaredScopes, context.snapshot.declaredScopes);
      }
      const executionError = wave.results.find((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (executionError) throw executionError.reason;
      const parkedDuringExecution = wave.parked;
      // Let recursive filesystem notifications queued by a synchronous adapter
      // reach the run-scoped journal before reconciliation reads its cursor.
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      if (parkedDuringExecution || isPausedRunStatus(readRunState(projectDir, runId).status)) {
        interrupted = true;
        break;
      }
      pending = deferred.map(({ stage }) => stage);
    }
    // Interrupted groups publish execution outcomes only. Validation and the
    // immutable gate result must wait for every serialized author to finish.
    if (!interrupted) await settleStageGroup(projectDir, runId, executedStages);
    for (const stage of executedStages) {
      const status = readStageStatus(projectDir, runId, stage.id);
      if (status.status === STAGE_STATUS.COMPLETE || status.status === STAGE_STATUS.FAILED) {
        recordStageOutcome(projectDir, runId, stage.id, iteration, status);
      }
    }
    syncStageStatuses(projectDir, runId, executedStages.map(stage => stage.id));
  }

  return { runScopeSafeStageGroup };
}

/** Both ordinary and repair waves bind validation and publish the same gate result. */
export async function settleStageGroup(projectDir: string, runId: string, stages: StageConfig[]): Promise<void> {
  for (const stage of stages.filter(stage => stage.is_gate)) {
    const status = readStageStatus(projectDir, runId, stage.id);
    if (status.status !== STAGE_STATUS.COMPLETE && status.status !== STAGE_STATUS.FAILED) continue;
    try {
      if (!bindReviewedGateValidation(projectDir, runId, stage.id, stages.map(peer => peer.id))) {
        await recordGateValidationDelta(projectDir, runId, stage.id);
      }
      await settleGateValidationEvidence(projectDir, runId, stage.id);
    } catch (error) {
      // A missing bound receipt fails closed in gate evaluation. Keep launch
      // failures inside settlement so the scheduler can publish that refusal.
      log.error({ stage: stage.id, error: error instanceof Error ? error.message : String(error) }, 'Could not settle gate validation');
    }
    settleGateEvaluation(projectDir, runId, stage.id);
  }
}
