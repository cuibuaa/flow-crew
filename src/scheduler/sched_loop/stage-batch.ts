import { runStageWave } from '../stage-wave.js';
// Boundary: Select and execute one scope-safe ready wave, coordinate live monitors and settle technical/failure/validation outcomes before terminal decisions.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState, transitionTechnicalRetryBudget } from '../../attempt-deadline.js';
import { evaluateCondition } from '../../condition.js';
import { recordRunEvent, recordStageOutcome } from '../../run-events.js';
import { markLeftoverStagesSkipped } from '../sched_admission/brief-contract.js';
import { StageConfig, WorkflowConfig, configuredTechnicalRetryLimit, failureRetryLimit } from '../sched_admission/configuration.js';
import { detectParallelWriteConflicts, selectRunnableBatch, transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { admittedTerminalDurableScope } from '../sched_policy/terminal-ownership.js';
import { createScopeBatchContext } from '../sched_scope/scope-batch.js';
import { stageWithInheritedScope } from '../sched_scope/scope-revisions.js';
import { enforceTemporalResearchTestContract, readmitScopeContinuation, recordThrownStageAttempt, settleScopeRevisionBoundary, settleDeferredStageAttempt, scopeRevisionBeforeSettlement, uniqueStructuredWriteOwners } from '../sched_scope/stage-group.js';
import { recordGateValidationDelta, bindReviewedGateValidation } from '../sched_settlement/gate-validation.js';
import { RUN_STATUS, STAGE_STATUS, StageStatus, StoreState, atomicWrite, isPausedRunStatus, isTerminalRunStatus, readRunState, readStageStatus, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { freshRunningStageProjection } from '../../worker.js';
import { executeOrdinaryStage } from './ordinary-stage.js';
import { join } from 'node:path';
import { consumePlanRevisions, findAllReady, monitorApprovalRequests, monitorScopeRevisionRequests, reconcileCompletedStageAttempts, tryParkOnApprovalRequest, tryTerminateOnTerminalState } from './services.js';

export async function executeReadyBatch(
  sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, runDirPath: string,
  workflow: WorkflowConfig, adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  technicalRetries: Map<string, TechnicalRetryBudgetState>, skills?: string, taskDescription?: string,
  availableSkills?: string, attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<{kind: 'settled' | 'continue'; state: StoreState}> {
    let ready = findAllReady(sorted, state);
    if (state.gatesDeferred && ready.some(stage => stage.is_gate)) {
      // Intermediate gates remain prerequisites: both candidates must finish
      // authoring before comparison. Hold only gates that unlock no pending
      // ordinary work; retry_to stages belong to the existing repair route.
      const authors = sorted.filter(stage => !stage.is_gate && !stage.retry_to?.length
        && state.stages[stage.id]?.status !== STAGE_STATUS.COMPLETE
        && state.stages[stage.id]?.status !== STAGE_STATUS.SKIPPED);
      const byId = new Map(sorted.map(stage => [stage.id, stage]));
      ready = ready.filter(stage => !stage.is_gate
        || authors.some(author => transitivelyDependsOn(author.id, stage.id, byId)));
      if (ready.length === 0 && authors.length === 0) {
        state.status = RUN_STATUS.PARKED;
        writeRunState(projectDir, runId, state);
        return { kind: 'settled', state };
      }
    }

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
      // Skip retry_to stages during initial execution; the inner loop handles them
      // But don't skip is_gate stages — they need to run to evaluate the gate
      if (stage.retry_to && stage.retry_to.length > 0 && !stage.is_gate) {
        skipOrdinaryStage(stage, state, projectDir, runId);
        continue;
      }
      if (stage.dynamic_dispatch && workflow.dispatch) {
        answerWithFixedPlan(stage, workflow.dispatch, state, projectDir, runId, runDirPath);
        continue;
      }
      runnableCandidates.push(stage);
    }

    const inheritedCandidates = runnableCandidates.map((stage) => stageWithInheritedScope(runDirPath, stage));
    const { selected: toRun, deferred: scopeDeferred } = selectRunnableBatch(inheritedCandidates);
    for (const { stage, conflict } of scopeDeferred) {
      const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
      log.info({ stage: stage.id, conflict }, 'Serializing ready stage because declared scopes are not provably disjoint');
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
    const activeScopeStageIds = ordinaryScopeContext.activeStageIds;
    const wave = await runStageWave(toRun, {
      activeStageIds: activeScopeStageIds,
      monitorScope: (isComplete) => monitorScopeRevisionRequests({ selected: toRun, activeStageIds: activeScopeStageIds, projectDir, runId, context: ordinaryScopeContext, isComplete }),
      monitorApproval: (isComplete) => monitorApprovalRequests({ selected: toRun, projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, isComplete }),
      execute: async (initialStage) => {
     let stage = initialStage;
     let closedResult: RunResult | undefined;
     try {
      while (true) {
        const item = await executeOrdinaryStage(stage, sorted, state, projectDir, runId, runDirPath, adapter, agents, resolvedAgentsDir, roleRegistry, technicalRetries, ordinaryScopeContext, skills, taskDescription, availableSkills, attemptDeadlineClockFactory, scopeRevisionBeforeSettlement({ stage, selected: toRun, activeStageIds: activeScopeStageIds, projectDir, runId, context: ordinaryScopeContext }, monitorScopeRevisionRequests));
        closedResult = item.result;
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        await monitorScopeRevisionRequests({ selected: toRun, activeStageIds: activeScopeStageIds,
          projectDir, runId, context: ordinaryScopeContext, isComplete: () => true });
        const reconciled = reconcileCompletedStageAttempts({
          stage, projectDir, runId, context: ordinaryScopeContext,
          terminalDurableScope: admittedTerminalDurableScope(runDirPath, stage.id, state.terminalStates),
        });
        if (reconciled.violation || enforceTemporalResearchTestContract(projectDir, runId, stage.id).violation) {
          item.result.exitCode = 1;
          item.result.timeoutTerminationCause = 'failed';
          settleDeferredStageAttempt(projectDir, runId, stage.id, item.result, false);
          return item;
        }
        const suspended = settleScopeRevisionBoundary({ stage, projectDir, runId, iteration: state.currentIteration ?? 1, reconciled });
        settleDeferredStageAttempt(projectDir, runId, stage.id, item.result, suspended);
        if (!suspended) return item;
        item.result.suspended = true;
        item.result.suspensionReason = 'scope_revision';
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        if (isPausedRunStatus(readRunState(projectDir, runId).status)) return item;
        const next = readmitScopeContinuation(stage, toRun, activeScopeStageIds, runDirPath, ordinaryScopeContext);
        if (!next) return item;
        stage = next;
      }
     } catch (err) {
       // A stage that THROWS (e.g. missing/invalid agent yaml at runtime) must not
       // reject Promise.all and unwind out of the loop, which would leave run.json
       // stuck 'running' forever (orphan). Degrade to a normal stage failure so the
       // downstream handling turns the run into 'failed'.
       const retriesNow = state.stages[stage.id]?.retries ?? 0;
       const msg = err instanceof Error ? err.message : String(err);
       log.error({ stage: stage.id, err: msg }, 'Stage threw before completion — degrading to failed');
       recordThrownStageAttempt(projectDir, runId, stage.id, retriesNow, err, closedResult);
       const failedResult: RunResult = { output: '', exitCode: 1, duration_ms: 0, timedOut: false, adapterError: false };
       return { stage, result: failedResult, currentRetries: retriesNow };
     }
      },
    });
    const rejected = wave.results.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = wave.results.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []);
    const parkedDuringExecution = wave.parked;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const temporalOwners = uniqueStructuredWriteOwners(
      projectDir,
      runId,
      results.map((item) => item.stage.id),
    );
    for (const item of results) {
      const postControlStatus = readStageStatus(projectDir, runId, item.stage.id);
      if (
        postControlStatus.status === STAGE_STATUS.PENDING
        && postControlStatus.attempts?.at(-1)?.status === 'suspended'
      ) {
        item.result.suspended = true;
        item.result.suspensionReason ??= 'approval';
      }
      if (item.result.exitCode === 0 && enforceTemporalResearchTestContract(
        projectDir,
        runId,
        item.stage.id,
        temporalOwners,
      ).violation) {
        item.result.exitCode = 1;
        item.result.timedOut = false;
        item.result.timeoutTerminationCause = 'failed';
      }
    }

    state = readRunState(projectDir, runId);
    let failed = false;
    let exhaustedAdapterFailure: {
      stageId: string;
      kind: NonNullable<RunResult['adapterFailureKind']>;
    } | undefined;

    for (const { stage, result, currentRetries } of results) {
      if (result.suspended) {
        technicalRetries.delete(stage.id);
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        log.info({ stage: stage.id, reason: result.suspensionReason }, 'Stage suspended at control boundary; re-dispatching');
        continue;
      }
      const maxFailureRetries = failureRetryLimit(stage, workflow, projectDir);
      const maxTechnicalRetries = configuredTechnicalRetryLimit(projectDir);
      const isAttemptTimeout = result.timedOut && result.timeoutTerminationCause === 'attempt_timeout';
      const isAdapterFailure = result.adapterFailureKind !== undefined;

      if ((isAttemptTimeout || isAdapterFailure) && currentRetries < maxTechnicalRetries) {
        const nextRetry = currentRetries + 1;
        const failedStatus = readStageStatus(projectDir, runId, stage.id);
        const retryStatus = rependStageStatus(failedStatus, nextRetry, failedStatus.error);
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn(
          { stage: stage.id, retry: nextRetry, adapterFailureKind: result.adapterFailureKind },
          isAdapterFailure ? 'Retrying adapter-failed stage' : 'Retrying timed-out stage',
        );
        continue;
      }

      if (isAttemptTimeout || isAdapterFailure) {
        const technicalRetry = technicalRetries.get(stage.id);
        // Timeout budget exhaustion is a terminal transition in the timeout
        // state machine. Adapter failures share the scheduler's retry count,
        // but deliberately do not masquerade as timeout terminal decisions.
        if (technicalRetry && isAttemptTimeout) {
          transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });
        }
        if (isAdapterFailure) {
          exhaustedAdapterFailure = { stageId: stage.id, kind: result.adapterFailureKind! };
        }
      }

      if (!isAttemptTimeout && !isAdapterFailure && result.exitCode !== 0 && currentRetries < maxFailureRetries) {
        // Preserve the failed attempt's `error`: buildRetryPreamble reads it to
        // tell the next attempt WHY the previous one died. Writing the pending
        // status without it left that branch dead, so EVERY non-timeout failure
        // was reported to the agent as "timed out" — including a diagnosed
        // parameter rejection, which now explains itself.
        const failedStatus = readStageStatus(projectDir, runId, stage.id);
        const retryStatus = rependStageStatus(failedStatus, currentRetries + 1, failedStatus.error);
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: currentRetries + 1, cause: retryStatus.error }, 'Retrying stage');
        continue;
      }

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

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      if (stage.is_gate && state.stages[stage.id].status === STAGE_STATUS.COMPLETE) {
        try {
          if (!bindReviewedGateValidation(projectDir, runId, stage.id, toRun.map(peer => peer.id))) await recordGateValidationDelta(projectDir, runId, stage.id);
        } catch (error) {
          // readGateVerdict fails closed when a run-local baseline exists but
          // its bound delta is missing.  Keep the stage settlement observable
          // and let gate adjudication report that failure instead of orphaning
          // the scheduler on a validation-launch exception.
          log.error({
            stage: stage.id,
            error: error instanceof Error ? error.message : String(error),
          }, 'Could not record gate validation delta');
        }
      }
      technicalRetries.delete(stage.id);
      stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
      log.info({ stage: stage.id }, 'Stage complete');
    }

    for (const conflict of detectParallelWriteConflicts(toRun.map((stage) => stage.id), state.stages)) {
      const detail = `${conflict.stageIds[0]} and ${conflict.stageIds[1]} both wrote ${conflict.files.join(', ')} (attribution: ${conflict.attribution.join(' / ')})`;
      log.warn({ conflict }, 'Parallel stages wrote the same file');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_write_conflict',
        runId,
        timestamp: new Date().toISOString(),
        iteration: state.currentIteration ?? 1,
        stageIds: conflict.stageIds,
        files: conflict.files,
        level: 'warning',
        detail,
      });
    }

    writeRunState(projectDir, runId, state);
    for (const event of stageEvents) {
      recordStageOutcome(projectDir, runId, event.stageId, state.currentIteration, event.status);
    }
    if (exhaustedAdapterFailure) {
      const detail = `Upstream adapter failure exhausted technical recovery for ${exhaustedAdapterFailure.stageId}: ${exhaustedAdapterFailure.kind}`;
      state.status = RUN_STATUS.FAILED;
      state.failureReason = detail;
      state.completedAt = new Date().toISOString();
      markLeftoverStagesSkipped(state, detail);
      writeRunState(projectDir, runId, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration: state.currentIteration ?? 1,
        stageId: exhaustedAdapterFailure.stageId,
        detail,
        source: 'scheduler',
        level: 'warning',
      });
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
