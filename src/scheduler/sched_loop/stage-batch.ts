import { atomicWrite } from '../../engine-fs.js';
import { concludeRun } from '../sched_policy/run-completion.js';
import { decideStageRetry } from '../sched_settlement/stage-execution.js';
import { runStageWave } from '../stage-wave.js';
// Select one shared-tree author and settle technical/failure/validation outcomes before terminal decisions.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState, transitionTechnicalRetryBudget } from '../../attempt-deadline.js';
import { evaluateCondition } from '../../condition.js';
import { recordRunEvent, recordStageOutcome } from '../../run-events.js';
import { StageConfig, WorkflowConfig, configuredTechnicalRetryLimit, failureRetryLimit } from '../sched_admission/configuration.js';
import { selectRunnableBatch } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { createScopeBatchContext } from '../sched_scope/scope-batch.js';
import { recordThrownStageAttempt, createStageSettlementBoundary, settleStageGroup } from '../sched_scope/stage-group.js';
import { RUN_STATUS, STAGE_STATUS, StageStatus, StoreState, isPausedRunStatus, isTerminalRunStatus, readRunState, readStageStatus, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { freshRunningStageProjection } from '../../worker.js';
import { executeOrdinaryStage } from './ordinary-stage.js';
import { join } from 'node:path';
import { consumePlanRevisions, findAllReady, monitorApprovalRequests, reconcileCompletedStageAttempts, tryParkOnApprovalRequest, tryTerminateOnTerminalState } from './services.js';

export async function executeReadyBatch(
  sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, runDirPath: string,
  workflow: WorkflowConfig, adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  technicalRetries: Map<string, TechnicalRetryBudgetState>, skills?: string, taskDescription?: string,
  availableSkills?: string, attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<{kind: 'settled' | 'continue'; state: StoreState}> {
    const ready = findAllReady(sorted, state);

    if (ready.length === 0) {
      // Don't set final status here — let the outer iteration loop check gates
      writeRunState(projectDir, runId, state);
      return { kind: 'settled', state };
    }

    const runnableCandidates: StageConfig[] = [];
    const stageEvents: Array<{ stageId: string; status: StageStatus }> = [];
    for (const stage of ready) {
      if (stage.condition) {
        const met = evaluateCondition(stage.condition, projectDir, runId);
        if (!met) {
          // A later conditional skip is a scheduling decision, not evidence
          // that an earlier completed execution never happened. Preserve its
          // immutable attempts so terminal ownership and audit attribution
          // remain provable across research iterations.
          skipOrdinaryStage(stage, state, projectDir, runId);
          log.info({ stage: stage.id }, 'Skipped (condition not met)');
          continue;
        }
      }
      if (stage.dynamic_dispatch && workflow.dispatch) {
        answerWithFixedPlan(stage, workflow.dispatch, state, projectDir, runId, runDirPath);
        continue;
      }
      runnableCandidates.push(stage);
    }

    const { selected: toRun, deferred: scopeDeferred } = selectRunnableBatch(runnableCandidates);
    for (const { stage, conflict } of scopeDeferred) {
      const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
      log.info({ stage: stage.id, conflict }, 'Waiting for the shared project tree owner to settle');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_scope_serialized',
        runId,
        timestamp: new Date().toISOString(),
        iteration: state.currentIteration ?? 1,
        stageId: stage.id,
        stageIds: [conflict.leftStageId, conflict.rightStageId],
        level: 'info',
        detail,
      });
    }

    if (toRun.length === 0) return { kind: 'continue', state };

    for (const stage of toRun) {
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      state.stages[stage.id] = freshRunningStageProjection(state.stages[stage.id], currentRetries);
    }
    writeRunState(projectDir, runId, state);

    const declaredCandidateById = new Map(runnableCandidates.map((stage) => [stage.id, stage]));
    const ordinaryScopeContext = createScopeBatchContext(
      projectDir,
      toRun.map((stage) => declaredCandidateById.get(stage.id) ?? stage),
      undefined,
      runId,
    );
    const wave = await runStageWave(toRun, {
      monitorApproval: (completion) => monitorApprovalRequests({ selected: toRun, projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, completion }),
      execute: async (initialStage) => {
     const stage = initialStage;
     try {
        const boundary = createStageSettlementBoundary({ stage, projectDir, runId, context: ordinaryScopeContext }, { reconcileCompletedStageAttempts });
        return await executeOrdinaryStage(stage, sorted, state, projectDir, runId, runDirPath, adapter, agents, resolvedAgentsDir, roleRegistry, technicalRetries, skills, taskDescription, availableSkills, attemptDeadlineClockFactory, boundary);
     } catch (err) {
       // A stage that THROWS (e.g. missing/invalid agent yaml at runtime) must not
       // reject Promise.all and unwind out of the loop, which would leave run.json
       // stuck 'running' forever (orphan). Degrade to a normal stage failure so the
       // downstream handling turns the run into 'failed'.
       const retriesNow = state.stages[stage.id]?.retries ?? 0;
       const msg = err instanceof Error ? err.message : String(err);
       log.error({ stage: stage.id, err: msg }, 'Stage threw before completion — degrading to failed');
       recordThrownStageAttempt(projectDir, runId, stage.id, retriesNow, err, { role: stage.role, iteration: state.currentIteration ?? 1 });
       const failedResult: RunResult = { output: '', exitCode: 1, duration_ms: 0, timedOut: false };
       return { stage, result: failedResult, currentRetries: retriesNow };
     }
      },
    });
    const rejected = wave.results.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = wave.results.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []);
    const parkedDuringExecution = wave.parked;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await settleStageGroup(projectDir, runId, toRun);
    for (const item of results) {
      const postControlStatus = readStageStatus(projectDir, runId, item.stage.id);
      if (
        postControlStatus.status === STAGE_STATUS.PENDING
        && postControlStatus.attempts?.at(-1)?.status === 'suspended'
      ) {
        item.result.suspended = true;
        item.result.suspensionReason ??= 'approval';
      }
    }

    state = readRunState(projectDir, runId);
    let failed = false;
    let exhaustedAdapterFailure: {
      stageId: string;
      kind: NonNullable<RunResult['providerFailure']>['kind'];
    } | undefined;

    for (const { stage, result, currentRetries } of results) {
      const decision = decideStageRetry(result, currentRetries, configuredTechnicalRetryLimit(), failureRetryLimit(stage, workflow));
      if (decision === 'engine_void') throw new Error(result.friendlyError);
      if (result.suspended) {
        technicalRetries.delete(stage.id);
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        log.info({ stage: stage.id, reason: result.suspensionReason }, 'Stage suspended at control boundary; re-dispatching');
        continue;
      }
      const isAdapterFailure = !!result.providerFailure && result.providerFailure.kind !== 'refusal';
      if (decision === 'retry') {
        const failedStatus = readStageStatus(projectDir, runId, stage.id);
        const retryStatus = rependStageStatus(failedStatus, currentRetries + 1, failedStatus.error);
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: currentRetries + 1, decision }, 'Retrying stage');
        continue;
      }
      if (result.terminationCause === 'attempt_timeout') {
        const technicalRetry = technicalRetries.get(stage.id);
        if (technicalRetry) transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });
      }
      if (isAdapterFailure) exhaustedAdapterFailure = { stageId: stage.id, kind: result.providerFailure!.kind };

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      if (result.exitCode !== 0) {
        technicalRetries.delete(stage.id);
        if (isAdapterFailure) {
          // The failed attempt remains in the append-only attempt ledger with
          // its adapter kind. Do not additionally emit a semantic
          // stage_failed outcome: technical exhaustion below owns the run
          // disposition and no worker outcome was observed.
          state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
          continue;
        }
        log.error({ stage: stage.id }, 'Stage failed');
        failed = true;
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
        continue;
      }

      technicalRetries.delete(stage.id);
      stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
      log.info({ stage: stage.id }, 'Stage complete');
    }

    writeRunState(projectDir, runId, state);
    for (const event of stageEvents) {
      recordStageOutcome(projectDir, runId, event.stageId, state.currentIteration, event.status);
    }
    if (exhaustedAdapterFailure) {
      const detail = `Upstream adapter failure exhausted technical recovery for ${exhaustedAdapterFailure.stageId}: ${exhaustedAdapterFailure.kind}`;
      state = await concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'adapter_failure', detail, eventFields: () => ({
        iteration: state.currentIteration ?? 1,
        stageId: exhaustedAdapterFailure.stageId,
        detail,
        source: 'scheduler',
        level: 'warning',
      }) });
      return { kind: 'settled', state };
    }
    if (parkedDuringExecution || isPausedRunStatus(state.status)) return { kind: 'settled', state };
    state = consumePlanRevisions(sorted, state, projectDir, runId, runDirPath, workflow, roleRegistry);
    if (isTerminalRunStatus(state.status)) return { kind: 'settled', state };

    // Scope admission may split one logical ready set into several physical
    // waves. Do not park, terminate, or return a failure between those waves:
    // the pre-E6 Promise.all batch let every ready peer finish, and its approval
    // requests/artifacts remained observable even when another peer failed.
    if (scopeDeferred.length > 0) {
      log.info({ deferred: scopeDeferred.map(({ stage }) => stage.id) }, 'Continuing serialized waves before batch-level terminal handling');
      return { kind: 'continue', state };
    }

    // Check approvals and terminal artifacts after every settled batch, before later stages can change them.
    const parkedEager = await tryParkOnApprovalRequest(state, {
      projectDir,
      runId,
      runDirPath,
      iteration: state.currentIteration ?? 1,
      candidateStageIds: toRun.map((stage) => stage.id),
    });
    if (parkedEager) return { kind: 'settled', state: parkedEager };

    const terminalEager = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, adapter });
    if (terminalEager.decision === 'matched') return { kind: 'settled', state: terminalEager.state };

    if (failed) {
      // Don't set run status to failed here — let the iteration loop handle it
      return { kind: 'settled', state };
    }
  return {kind: 'continue', state};
}

/** A workflow's fixed plan is its plan stage's answer: published where a planner's record goes, with
 * no model call, for the next admission pass to accept or refuse like any proposal. */
function answerWithFixedPlan(stage: StageConfig, dispatch: readonly unknown[], state: StoreState, projectDir: string, runId: string, runDirPath: string): void {
  atomicWrite(join(runDirPath, 'dispatch.yaml'), `${JSON.stringify({ stages: dispatch })}\n`);
  const answered: StageStatus = { status: STAGE_STATUS.COMPLETE, retries: state.stages[stage.id]?.retries ?? 0, completedAt: new Date().toISOString() };
  writeStageStatus(projectDir, runId, stage.id, answered);
  state.stages[stage.id] = answered;
  writeRunState(projectDir, runId, state);
  recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, answered);
}

function skipOrdinaryStage(stage: StageConfig, state: StoreState, projectDir: string, runId: string): void {
const previous = (() => {
            try { return readStageStatus(projectDir, runId, stage.id); }
            catch { return state.stages[stage.id]; }
          })();
          const skipped: StageStatus = { ...previous, status: STAGE_STATUS.SKIPPED, retries: previous?.retries ?? 0 };
          writeStageStatus(projectDir, runId, stage.id, skipped);
          state.stages[stage.id] = skipped;
          writeRunState(projectDir, runId, state);
          recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, skipped);
}
