// Boundary: Run admitted disjoint batches, coordinate existing approval/revision monitors, settle audits, temporal tests, suspension and thrown attempts; stage execution is a supplied callback.
import { STAGE_STATUS, type StoreState, readRunState, readStageStatus, runDir, writeStageStatus, type StageStatus, completeStageAttempt, isPausedRunStatus, suspendStageAttempt, writeRunState } from "../../store.js";
import { inspectTemporalResearchTests } from "../../temporal-test-guard.js";
import { isAbsolute, join, relative } from "node:path";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { recordRunEvent, recordStageOutcome } from "../../run-events.js";
import { writeFileSync } from "node:fs";
import { log } from "../sched_admission/shared.js";
import { type LiveConstraintGuardFactory } from "../../live-constraint-guard.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { detectParallelWriteConflicts, selectRunnableBatch } from "../sched_admission/frontier.js";
import { type RepairRoundSnapshot } from './snapshots.js';
import { createScopeBatchContext } from './scope-batch.js';
import { stageWithInheritedScope } from './scope-revisions.js';
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
  if (status.status !== STAGE_STATUS.COMPLETE || attempt?.exitCode !== 0) return { violation: false };
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
): StageStatus | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  try {
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

export function createScopeSafeStageRunner(services: ScopeSafeStageServices) {
  const { monitorApprovalRequests, monitorScopeRevisionRequests, createSchedulerLiveConstraintGuardFactory, reconcileCompletedStageAttempts } = services;

  async function runScopeSafeStageGroup(
    stages: StageConfig[],
    projectDir: string,
    runId: string,
    iteration: number,
    execute: (stage: StageConfig, liveConstraintGuardFactory?: LiveConstraintGuardFactory) => Promise<void>,
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
      const activeStageIds = new Set(selected.map((stage) => stage.id));
      const context = createScopeBatchContext(
        projectDir,
        selected.map((stage) => declaredStageById.get(stage.id) ?? stage),
        snapshot,
        runId,
      );
      let complete = false;
      const executions = Promise.all(selected.map(async (stage) => {
        try {
          await execute(stage, createSchedulerLiveConstraintGuardFactory({ stage, projectDir, runId, context }));
        }
        catch (error) {
          const retries = (() => {
            try { return readStageStatus(projectDir, runId, stage.id).retries; }
            catch { return 0; }
          })();
          recordThrownStageAttempt(projectDir, runId, stage.id, retries, error);
          throw error;
        }
        finally { activeStageIds.delete(stage.id); }
      }));
      const monitor = monitorScopeRevisionRequests({
        selected,
        activeStageIds,
        projectDir,
        runId,
        context,
        isComplete: () => complete,
      });
      const approvalMonitor = monitorApprovalRequests({
        selected,
        projectDir,
        runId,
        runDirPath,
        iteration,
        isComplete: () => complete,
      });
      let executionError: unknown;
      let parkedDuringExecution: StoreState | null = null;
      try {
        await executions;
      } catch (error) {
        executionError = error;
      } finally {
        complete = true;
        await monitor;
        parkedDuringExecution = await approvalMonitor;
      }
      if (executionError) throw executionError;
      // Let recursive filesystem notifications queued by a synchronous adapter
      // reach the run-scoped journal before reconciliation reads its cursor.
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      const redispatch: StageConfig[] = [];
      const temporalOwners = uniqueStructuredWriteOwners(
        projectDir,
        runId,
        selected.map((stage) => stage.id),
      );
      for (const stage of selected) {
        const reconciled = reconcileCompletedStageAttempts({ stage, projectDir, runId, context });
        const temporal = enforceTemporalResearchTestContract(projectDir, runId, stage.id, temporalOwners);
        const acceptedAttempt = reconciled.attemptIndex === undefined
          ? undefined
          : reconciled.status.attempts?.find((attempt) => attempt.index === reconciled.attemptIndex);
        if (
          !reconciled.violation
          && !temporal.violation
          && reconciled.acceptedRevisionDuringAttempt
          && reconciled.attemptIndex !== undefined
          && acceptedAttempt?.exitCode === 0
          && readStageStatus(projectDir, runId, stage.id).status === STAGE_STATUS.COMPLETE
        ) {
          suspendStageAttempt(projectDir, runId, stage.id, reconciled.attemptIndex);
          redispatch.push(stageWithInheritedScope(runDirPath, stage));
          recordRunEvent(projectDir, runId, {
            type: 'attempt_suspended', runId, timestamp: new Date().toISOString(), iteration,
            stageId: stage.id, attemptIndex: reconciled.attemptIndex,
            detail: 'accepted scope revision requires re-dispatch of the same stage', source: 'scheduler',
          });
        } else {
          const finalStatus = readStageStatus(projectDir, runId, stage.id);
          if (finalStatus.status === STAGE_STATUS.COMPLETE || finalStatus.status === STAGE_STATUS.FAILED) {
            recordStageOutcome(projectDir, runId, stage.id, iteration, finalStatus);
          }
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
