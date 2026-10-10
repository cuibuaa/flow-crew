import { runStageWave } from '../stage-wave.js';
import { recordGateValidationDelta } from '../sched_settlement/gate-validation.js';
// Boundary: Run admitted disjoint batches, coordinate existing approval/revision monitors, settle audits, temporal tests, suspension and thrown attempts; stage execution is a supplied callback.
import { STAGE_STATUS, type StoreState, readRunState, readStageStatus, runDir, writeStageStatus, type StageStatus, completeStageAttempt, isPausedRunStatus, suspendStageAttempt, writeRunState } from "../../store.js";
import { inspectTemporalResearchTests } from "../../temporal-test-guard.js";
import { isAbsolute, join, relative } from "node:path";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { recordRunEvent, recordStageOutcome } from "../../run-events.js";
import { writeFileSync } from "node:fs";
import { log } from "../sched_admission/shared.js";
import { type RunResult } from '../../adapters/base.js';
import { type LiveConstraintGuardFactory } from "../../live-constraint-guard.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { detectParallelWriteConflicts, selectRunnableBatch } from "../sched_admission/frontier.js";
import { type RepairRoundSnapshot } from './snapshots.js';
import { type ScopeBatchContext, createScopeBatchContext, getScopeAttemptContext } from './scope-batch.js';
import { acceptedInheritedScope, stageWithInheritedScope } from './scope-revisions.js';
import { type createApprovalMonitor } from "../sched_policy/approvals.js";
import { type createScopeRevisionMonitor } from './revision-monitor.js';
import { type createLiveGuardFactory } from './write-enforcement.js';
import { type createScopeReconciler } from './reconciliation.js';

export function allDone(state: StoreState): boolean {
  return Object.values(state.stages).every(
    // A skip is a terminal disposition for whole-DAG settlement, but it is not
    // successful production and therefore cannot satisfy a dependency.
    (s) => s.status === STAGE_STATUS.COMPLETE || s.status === STAGE_STATUS.SKIPPED,
  );
}

export function anyFailed(state: StoreState): boolean {
  return Object.values(state.stages).some((s) => s.status === STAGE_STATUS.FAILED);
}

export function enforceTemporalResearchTestContract(
  projectDir: string,
  runId: string,
  stageId: string,
  structuredOwners?: ReadonlyMap<string, string | null>,
): { violation: boolean; reason?: string } {
  const state = readRunState(projectDir, runId);
  if (!state.research) return { violation: false };
  const status = readStageStatus(projectDir, runId, stageId);
  const attempt = status.attempts?.at(-1);
  if ((status.status !== STAGE_STATUS.COMPLETE && !(status.status === STAGE_STATUS.PENDING && attempt?.status === 'suspended')) || attempt?.exitCode !== 0) return { violation: false };
  // A batch snapshot can contain a file written by any concurrently running
  // stage. Only the adapter's structured write list identifies the writer, so
  // snapshot/unknown attribution is evidence to audit, not grounds to fail the
  // observing stage.
  if (attempt.writeAttribution !== 'structured') return { violation: false };
  const writes = (attempt.writes ?? status.writes ?? []).filter((rawPath) => {
    if (!structuredOwners) return true;
    const relativePath = isAbsolute(rawPath)
      ? relative(projectDir, rawPath).replace(/\\/g, '/')
      : rawPath;
    const normalized = normalizedProjectPath(relativePath);
    return normalized !== undefined && structuredOwners.get(normalized) === stageId;
  });
  const findings = inspectTemporalResearchTests({
    projectDir,
    writes,
    resultFile: state.research.resultFile,
    terminalPaths: Object.values(state.terminalStates ?? {}).flatMap((entry) => entry.paths),
  });
  if (findings.length === 0) return { violation: false };
  const attributedFindings = findings.map((finding) => ({
    ...finding,
    stageId,
    attemptIndex: attempt.index,
    writeAttribution: 'structured' as const,
  }));
  const reason = `Temporal test contract rejected ${findings.length} generated test(s): ${findings.map((finding) => `${finding.file}: ${finding.reason}`).join('; ')}`;
  const guardPath = join(runDir(projectDir, runId), 'stages', stageId, 'temporal_test_guard.json');
  try {
    writeFileSync(guardPath, `${JSON.stringify({ version: 1, pass: false, findings: attributedFindings }, null, 2)}\n`, 'utf-8');
  } catch { /* the status remains authoritative */ }
  status.status = STAGE_STATUS.FAILED;
  status.exitCode = 1;
  status.error = reason;
  if (attempt) {
    attempt.status = STAGE_STATUS.FAILED;
    attempt.exitCode = 1;
    attempt.error = reason;
  }
  writeStageStatus(projectDir, runId, stageId, status);
  recordRunEvent(projectDir, runId, {
    type: 'attempt_failed', runId, timestamp: new Date().toISOString(), stageId,
    attemptIndex: attempt?.index, attemptStartedAt: attempt?.startedAt,
    status: STAGE_STATUS.FAILED, detail: reason, source: 'scheduler', level: 'warning',
  });
  return { violation: true, reason };
}

export function uniqueStructuredWriteOwners(
  projectDir: string,
  runId: string,
  stageIds: readonly string[],
): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  for (const stageId of stageIds) {
    const status = readStageStatus(projectDir, runId, stageId);
    const attempt = status.attempts?.at(-1);
    if (attempt?.writeAttribution !== 'structured') continue;
    for (const rawPath of attempt.writes ?? status.writes ?? []) {
      const relativePath = isAbsolute(rawPath)
        ? relative(projectDir, rawPath).replace(/\\/g, '/')
        : rawPath;
      const normalized = normalizedProjectPath(relativePath);
      if (!normalized) continue;
      const prior = owners.get(normalized);
      if (prior === undefined) owners.set(normalized, stageId);
      else if (prior !== stageId) owners.set(normalized, null);
    }
  }
  return owners;
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
  closedResult?: RunResult,
): StageStatus | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    if (closedResult?.settleAttempt) {
      // Reconciliation failed after a child closed. Fail that same execution;
      // a second attempt would invent a child that was never started.
      const final = readStageStatus(projectDir, runId, stageId);
      const attempt = final.attempts?.at(-1);
      if (!attempt) throw new Error(`Closed child ${stageId} has no attempt`);
      attempt.status = STAGE_STATUS.FAILED;
      attempt.exitCode = 1;
      attempt.error = detail;
      final.status = STAGE_STATUS.FAILED;
      final.exitCode = 1;
      final.error = detail;
      final.completedAt = attempt.completedAt;
      writeStageStatus(projectDir, runId, stageId, final);
      settleDeferredStageAttempt(projectDir, runId, stageId, closedResult, false);
      return final;
    }
    const final = completeStageAttempt(projectDir, runId, stageId, retries, {
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
      attemptIndex: attempt?.index,
      attemptStartedAt: attempt?.startedAt,
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

/** Settle one closed child before a peer can delay its control boundary. */
export function settleScopeRevisionBoundary(input: {
  stage: StageConfig; projectDir: string; runId: string; iteration: number;
  reconciled: { status: StageStatus; violation: boolean; acceptedRevisionDuringAttempt: boolean; attemptIndex?: number };
}): boolean {
  const { reconciled } = input;
  const attempt = reconciled.status.attempts?.find((entry) => entry.index === reconciled.attemptIndex);
  if (reconciled.violation || !reconciled.acceptedRevisionDuringAttempt
      || reconciled.attemptIndex === undefined || attempt?.exitCode !== 0
      || ![String(STAGE_STATUS.COMPLETE), String(STAGE_STATUS.PENDING)].includes(readStageStatus(input.projectDir, input.runId, input.stage.id).status)) return false;
  suspendStageAttempt(input.projectDir, input.runId, input.stage.id, reconciled.attemptIndex);
  return true;
}

/** Flush a synchronous-close request before worker artifact verification and settlement. */
export function scopeRevisionBeforeSettlement(input: {
  stage: StageConfig; selected: StageConfig[]; activeStageIds: Set<string>;
  projectDir: string; runId: string; context: ScopeBatchContext;
}, monitor: ScopeSafeStageServices['monitorScopeRevisionRequests']): () => Promise<boolean> {
  return async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await monitor({ ...input, isComplete: () => true });
    const attempt = readStageStatus(input.projectDir, input.runId, input.stage.id).attempts?.at(-1);
    return attempt !== undefined && getScopeAttemptContext(input.context, input.stage.id, attempt.index).acceptedDuringAttempt;
  };
}

/** Publish a final outcome only after scope/temporal reconciliation. */
export function settleDeferredStageAttempt(projectDir: string, runId: string, stageId: string, result: RunResult | undefined, suspended: boolean): void {
  if (!result?.settleAttempt) return;
  const status = readStageStatus(projectDir, runId, stageId);
  const attempt = status.attempts?.at(-1);
  if (!suspended && !result.suspended && status.status === STAGE_STATUS.PENDING && attempt?.status === 'suspended') {
    attempt.status = result.exitCode === 0 ? STAGE_STATUS.COMPLETE : STAGE_STATUS.FAILED;
    status.status = attempt.status;
    status.exitCode = attempt.exitCode;
    status.completedAt = attempt.completedAt;
    status.error = attempt.error;
    writeStageStatus(projectDir, runId, stageId, status);
  }
  const settle = result.settleAttempt;
  delete result.settleAttempt;
  settle();
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
  context.inheritedScopes.set(stage.id, inherited.scope);
  context.inheritedDecisionPaths.set(stage.id, new Set(inherited.decisionPaths));
  return revised;
}

export function createScopeSafeStageRunner(services: ScopeSafeStageServices) {
  const { monitorApprovalRequests, monitorScopeRevisionRequests, createSchedulerLiveConstraintGuardFactory, reconcileCompletedStageAttempts } = services;

  async function runScopeSafeStageGroup(
    stages: StageConfig[],
    projectDir: string,
    runId: string,
    iteration: number,
    execute: (stage: StageConfig, liveConstraintGuardFactory?: LiveConstraintGuardFactory, beforeSettlement?: () => Promise<boolean>) => Promise<RunResult | void>,
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
        monitorScope: (isComplete) => monitorScopeRevisionRequests({ selected, activeStageIds, projectDir, runId, context, isComplete }),
        monitorApproval: (isComplete) => monitorApprovalRequests({ selected, projectDir, runId, runDirPath, iteration, isComplete }),
        execute: async (initialStage) => {
        let stage = initialStage;
        let result: RunResult | void = undefined;
        try {
          while (true) {
            result = await execute(stage, createSchedulerLiveConstraintGuardFactory({ stage, projectDir, runId, context }), scopeRevisionBeforeSettlement({ stage, selected, activeStageIds, projectDir, runId, context }, monitorScopeRevisionRequests));
            await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
            // Flush the same monitor with a settled observation, including
            // requests written by a synchronous adapter just before close.
            await monitorScopeRevisionRequests({ selected, activeStageIds, projectDir, runId, context, isComplete: () => true });
            const reconciled = reconcileCompletedStageAttempts({ stage, projectDir, runId, context });
            const temporal = enforceTemporalResearchTestContract(projectDir, runId, stage.id);
            const suspended = !temporal.violation && settleScopeRevisionBoundary({ stage, projectDir, runId, iteration, reconciled });
            settleDeferredStageAttempt(projectDir, runId, stage.id, result || undefined, suspended);
            if (temporal.violation || !suspended) break;
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
          recordThrownStageAttempt(projectDir, runId, stage.id, retries, error, result || undefined);
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
      const temporalOwners = uniqueStructuredWriteOwners(
        projectDir,
        runId,
        selected.map((stage) => stage.id),
      );
      for (const stage of selected) {
        const temporal = enforceTemporalResearchTestContract(projectDir, runId, stage.id, temporalOwners);
        const finalStatus = readStageStatus(projectDir, runId, stage.id);
        if (!temporal.violation && (finalStatus.status === STAGE_STATUS.COMPLETE || finalStatus.status === STAGE_STATUS.FAILED)) {
          if (stage.is_gate && finalStatus.status === STAGE_STATUS.COMPLETE) await recordGateValidationDelta(projectDir, runId, stage.id);
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
