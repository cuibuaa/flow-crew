// Boundary: Own bounded gate repair and re-evaluation cycles from fresh runtime facts; resume admitted successors and supervisor rework without bypassing rejection.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { captureRepairRoundSnapshot } from '../sched_scope/snapshots.js';
import { syncStageStatuses } from '../sched_scope/stage-group.js';
import { archiveGateRoundEvidence, archiveRejectedGateRuntimeFacts, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { classifyGateRecoveryFact, collectGateRuntimeFacts, findGateRecoveryStages, gateIdsForRecoveryStages, gateRetryDiagnosticSnapshot } from '../sched_settlement/gate-recovery.js';
import { executeSingleStage } from '../sched_settlement/stage-execution.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, isPausedRunStatus, isPendingStageStatus, isTerminalRunStatus, readRunState, rependStageStatus, writeRunState } from '../../store.js';
import { loadGateContract } from '../sched_settlement/gate-contract.js';
import { readGateVerdict } from '../sched_settlement/gate-verdict.js';
import { readRunValidationBaseline, settleGateValidationEvidence } from '../sched_settlement/gate-validation.js';
import { recordRunEvent } from '../../run-events.js';
import { executeIteration } from './iteration.js';
import { admitScopedAuditRepairs, runScopeSafeStageGroup, terminateForGateContractRefusal, writeRepairRoundDiffArtifact } from './services.js';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export async function settleGateRetries(
  state: StoreState, sorted: StageConfig[], iteration: number,
  iterationDispatchedIds: string[], injectedDispatchStages: Set<string>,
  planStageRetries: Map<string, number>,
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
): Promise<{kind: 'settled'; state: StoreState} | {
  kind: 'continue'; state: StoreState; maxInnerRetries: number; innerRetriesUsed: number;
}> {
    state = readRunState(projectDir, runId);
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = Math.max(0, Math.floor(Number(
      state.maxRetries ?? loadDefaults(projectDir).gate_retry_loops,
    )));
    let innerRetriesUsed = 0;
    let revisitRuntimeFacts = true;
    while (revisitRuntimeFacts) {
    revisitRuntimeFacts = false;
    state = readRunState(projectDir, runId);
      // Mechanical settlement belongs to every completed gate. Dispatch origin
      // only controls the dynamic repair topology below, not validation evidence.
      if (readRunValidationBaseline(runDirPath)) {
        const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
        for (const gate of sorted.filter((stage) => stage.is_gate && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE)) {
          // All authored controls must pass independently before a mechanical
          // retry can preserve their review. Final adjudication checks both again.
          if (readGateVerdict(projectDir, gate.id, runId, contract, true, false)?.pass !== true) continue;
          const validation = await settleGateValidationEvidence(projectDir, runId, gate.id);
          state = readRunState(projectDir, runId);
          if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };
          if (validation.kind === 'refused') {
            state.status = RUN_STATUS.FAILED;
            state.failureReason = validation.reason;
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            recordRunEvent(projectDir, runId, { type: 'run_completed', runId, timestamp: state.completedAt, iteration, detail: validation.reason });
            return { kind: 'settled', state };
          }
        }
      }
      // Terminal rejection is independent of dynamic dispatch and repair budget.
      // Settle it before any finding-derived revision or repair can be admitted.
      if (iterationDispatchedIds.length === 0) {
        const terminalFacts = collectGateRuntimeFacts(sorted, state, projectDir, runId);
        if (terminalFacts.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
            && terminateForGateContractRefusal(state, terminalFacts, projectDir, runId, iteration)) return { kind: 'settled', state };
      }
    if (iterationDispatchedIds.length > 0) {
      const outerCheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
      if (outerCheck.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
          && terminateForGateContractRefusal(state, outerCheck, projectDir, runId, iteration)) return { kind: 'settled', state };
      const { allPass, failedGateIds, rejectedGateIds } = outerCheck;
      state = admitScopedAuditRepairs(sorted, state, outerCheck, projectDir, runId, runDirPath, workflow, roleRegistry);
      log.info({
        event: 'gate_retry_outer_check',
        runId,
        iteration,
        source: 'fresh-runtime-collection',
        allPass,
        failedGateIds,
        rejectedGateIds,
        ...gateRetryDiagnosticSnapshot(sorted, state, projectDir, runId, runDirPath, outerCheck),
      }, 'Gate retry outer check');
      if (outerCheck.contractRefusals.length > 0) {
        archiveRejectedGateRuntimeFacts(
          runDirPath,
          gateArchiveCoordinate(iteration, 1),
          outerCheck,
        );
      }
      if (maxInnerRetries === 0
          && terminateForGateContractRefusal(state, outerCheck, projectDir, runId, iteration)) return { kind: 'settled', state };
      if (!allPass) {
        // Terminal incompleteness is not a repair verdict. Only a completed,
        // validated pass:false fact can make its retry_to stage eligible.
        const retryStages = findGateRecoveryStages(
          sorted,
          rejectedGateIds,
          Object.fromEntries(outerCheck.evaluations.map((entry) => [entry.id, entry.effectiveVerdict?.reason])),
          state.research,
          Object.fromEntries(outerCheck.evaluations.map((entry) => [entry.id, classifyGateRecoveryFact(
            entry.id,
            entry.authoredVerdict,
            entry.effectiveVerdict,
          )])),
        );
        if (retryStages.length > 0) {
          for (let inner = innerRetriesUsed; inner < maxInnerRetries; inner++) {

            // Check for cancellation between retries
            state = readRunState(projectDir, runId);
            if (isTerminalRunStatus(state.status)) break;

            // Determine which retry stages need to run based on current failed gates
            // Mechanism fix: the entrance owns one coherent, current policy-aware
            // fact read. Round zero must not inherit the outer snapshot because a
            // verdict/metric/status may have been reconciled after that snapshot.
            const currentCheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
            if (currentCheck.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
                && terminateForGateContractRefusal(state, currentCheck, projectDir, runId, iteration)) return { kind: 'settled', state };
            if (currentCheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, inner + 1),
                currentCheck,
              );
            }
            const currentRejectedGateIds = currentCheck.rejectedGateIds;
            state = admitScopedAuditRepairs(sorted, state, currentCheck, projectDir, runId, runDirPath, workflow, roleRegistry);
            const breakConditions = { allPass: currentCheck.allPass };
            const shouldBreakForPassingGates = breakConditions.allPass;
            log.info({
              event: 'gate_retry_entry_check',
              runId,
              iteration,
              inner,
              source: 'fresh-runtime-collection',
              allPass: currentCheck.allPass,
              failedGateIds: currentCheck.failedGateIds,
              rejectedGateIds: currentCheck.rejectedGateIds,
              currentRejectedGateIds,
              breakConditions,
              decision: shouldBreakForPassingGates ? 'break' : 'continue',
              unsatisfiedBreakConditions: Object.entries(breakConditions)
                .filter(([, satisfied]) => !satisfied)
                .map(([condition]) => condition),
              ...gateRetryDiagnosticSnapshot(sorted, state, projectDir, runId, runDirPath, currentCheck),
            }, 'Gate retry entry check');
            if (shouldBreakForPassingGates) break;

            const activeRecoveryStages = findGateRecoveryStages(
              sorted,
              currentRejectedGateIds,
              Object.fromEntries(currentCheck.evaluations.map((entry) => [entry.id, entry.effectiveVerdict?.reason])),
              state.research,
              Object.fromEntries(currentCheck.evaluations.map((entry) => [entry.id, classifyGateRecoveryFact(
                entry.id,
                entry.authoredVerdict,
                entry.effectiveVerdict,
              )])),
            );
            if (activeRecoveryStages.length === 0) {
              log.info({ event: 'gate_retry_entry_break', runId, iteration, inner, reason: 'no-active-retry-stages' }, 'Gate retry entry break');
              break;
            }

            const repairRound = inner + 1;
            const activeGateIds = gateIdsForRecoveryStages(
              sorted,
              currentRejectedGateIds,
              activeRecoveryStages,
              state.research,
            );
            const activeWorkRecoveryStages = activeRecoveryStages.filter((stage) => !stage.is_gate);
            // Defense in depth (not the mechanism fix): immediately before any
            // evidence clearing, reset, or repair dispatch, re-read exactly the
            // related gates. A stale entrance can never launch repair over a set
            // that is now fully accepted.
            const dispatchState = readRunState(projectDir, runId);
            const activeGateSet = new Set(activeGateIds);
            const dispatchCheck = collectGateRuntimeFacts(
              sorted.filter((stage) => stage.is_gate && activeGateSet.has(stage.id)),
              dispatchState,
              projectDir,
              runId,
            );
            if (dispatchCheck.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
                && terminateForGateContractRefusal(dispatchState, dispatchCheck, projectDir, runId, iteration)) return { kind: 'settled', state: dispatchState };
            if (dispatchCheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, repairRound),
                dispatchCheck,
              );
            }
            if (dispatchCheck.allPass) {
              state = dispatchState;
              log.info({
                event: 'gate_retry_dispatch_guard',
                runId,
                iteration,
                inner,
                activeGateIds,
                allPass: dispatchCheck.allPass,
                failedGateIds: dispatchCheck.failedGateIds,
                rejectedGateIds: dispatchCheck.rejectedGateIds,
                decision: 'skip-repair-dispatch',
              }, 'Gate retry dispatch guard stopped a stale repair dispatch');
              break;
            }
            // Preserve the rejected evidence before the live verdict/output paths
            // are reused, then capture the repair preimage while it is still exact.
            archiveGateRoundEvidence(
              runDirPath,
              gateArchiveCoordinate(iteration, repairRound),
              activeGateIds,
              new Map(
                dispatchCheck.evaluations
                  .filter((e) => e.effectiveVerdict)
                  .map((e) => [e.id, e.effectiveVerdict!] as const),
              ),
            );
            const repairSnapshot = captureRepairRoundSnapshot(projectDir, activeWorkRecoveryStages, { runDirPath });

            // Keep the rejected gate evidence live until repair succeeds. A
            // repair attempt may suspend for approval, and that durable verdict
            // is what lets a replacement scheduler resume the same retry loop.
            // The re-evaluation block below clears each gate immediately before
            // it is dispatched again.
            const sharedVerdict = join(runDirPath, 'verdict.json');

            // Reset and run all active retry stages (possibly in parallel)
            for (const retryStage of activeWorkRecoveryStages) {
              state.stages[retryStage.id] = rependStageStatus(state.stages[retryStage.id], 0);
              mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current execution's output
              const liveLog = join(runDirPath, 'stages', retryStage.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
            }
            writeRunState(projectDir, runId, state);

            if (activeWorkRecoveryStages.length > 0) {
              await runScopeSafeStageGroup(
                activeWorkRecoveryStages,
                projectDir,
                runId,
                state.currentIteration ?? 1,
                (retryStage, liveConstraintGuardFactory, beforeSettlement) => executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, undefined, undefined, availableSkillsList, attemptDeadlineClockFactory, liveConstraintGuardFactory, beforeSettlement),
                repairSnapshot,
              );
            }
            innerRetriesUsed = inner + 1;
            syncStageStatuses(projectDir, runId, activeWorkRecoveryStages.map(s => s.id));
            state = readRunState(projectDir, runId);
            if (isPausedRunStatus(state.status)) return { kind: 'settled', state };
            const roundDiffPath = writeRepairRoundDiffArtifact({
              snapshot: repairSnapshot,
              projectDir,
              runDirPath,
              iteration,
              round: repairRound,
              repairStages: activeWorkRecoveryStages,
              statuses: state.stages,
            });

            // Check for cancellation after fix stages complete
            if (isTerminalRunStatus(state.status)) break;

            // Skip gate re-runs if any fix stage itself failed (saves wasted agent calls)
            const anyFixFailed = activeWorkRecoveryStages.some(s => state.stages[s.id]?.status === STAGE_STATUS.FAILED);
            if (anyFixFailed) {
              // If the failure is a transient adapter error, continue to next retry instead of aborting
              const allAdapterErrors = activeWorkRecoveryStages
                .filter(s => state.stages[s.id]?.status === STAGE_STATUS.FAILED)
                .every(s => state.stages[s.id]?.error === 'adapter connection failed');
              if (allAdapterErrors && inner < maxInnerRetries - 1) {
                log.info({ runId, iteration, inner }, 'Fix stage failed due to adapter error — retrying');
                continue;
              }
              log.info({ runId, iteration, inner }, 'Fix stage failed — skipping gate re-evaluation');
              break;
            }

            // Collect all gates referenced by all active retry stages
            const allRetryGateIds = new Set(activeGateIds);

            // Determine which gates to re-run
            // A repair was admitted from the policy-aware dispatch snapshot,
            // so every gate that authorized that repair must be re-evaluated.
            // Re-reading the old live artifact here can race a metric source
            // and incorrectly turn completed repair work into no-op success.
            const gatesToRerun = sorted.filter(s => s.is_gate && allRetryGateIds.has(s.id));
            for (const gate of gatesToRerun) {
              const perGate = join(runDirPath, `verdict_${gate.id}.json`);
              if (existsSync(perGate)) unlinkSync(perGate);
              const gateMetric = join(runDirPath, 'stages', gate.id, 'metric.json');
              if (existsSync(gateMetric)) unlinkSync(gateMetric);
              // Keep any structured correction until gate continuation choice:
              // gateContinuationSessionForStage consumes it exactly once and
              // cold-starts the re-evaluation when prior reasoning was wrong.
              state.stages[gate.id] = rependStageStatus(state.stages[gate.id], 0);
              mkdirSync(join(runDirPath, 'stages', gate.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current re-evaluation's output
              const liveLog = join(runDirPath, 'stages', gate.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
              writeRunState(projectDir, runId, state);
            }
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Run gate stages (possibly in parallel), passing fix stage IDs for context
            if (gatesToRerun.length > 0) {
              await runScopeSafeStageGroup(
                gatesToRerun,
                projectDir,
                runId,
                state.currentIteration ?? 1,
                (gate, liveConstraintGuardFactory, beforeSettlement) => executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, activeWorkRecoveryStages.map(s => s.id), roundDiffPath, availableSkillsList, attemptDeadlineClockFactory, liveConstraintGuardFactory, beforeSettlement),
              );
              syncStageStatuses(projectDir, runId, gatesToRerun.map(s => s.id));
            }
            state = readRunState(projectDir, runId);
            if (isPausedRunStatus(state.status)) return { kind: 'settled', state };

            // Check gates again
            const recheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
            state = admitScopedAuditRepairs(sorted, state, recheck, projectDir, runId, runDirPath, workflow, roleRegistry);
            if (recheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, inner + 2),
                recheck,
              );
            }
            if (recheck.allPass) break;
            if (inner === maxInnerRetries - 1) {
              log.info({ runId, iteration }, 'Inner loop exhausted, falling back to outer re-plan');
            }
          }
        }
      }
    }

    // A contract/evidence rejection is routed back to its gate rather than to
    // product repair. If that producer exhausts the bounded gate retry budget
    // without supplying the required numeric evidence, retain the established
    // hard refusal instead of allowing an outer re-plan to dilute it into a
    // generic incomplete outcome.
    state = readRunState(projectDir, runId);
    const exhaustedContractFacts = collectGateRuntimeFacts(sorted, state, projectDir, runId);
    if (terminateForGateContractRefusal(
      state,
      exhaustedContractFacts,
      projectDir,
      runId,
      iteration,
    )) return { kind: 'settled', state };

    // A rejected gate blocks successors. Once no explicit rejection remains,
    // resume the DAG even if later gates are still pending; then revisit runtime
    // facts so a newly-run later gate can trigger only its own repair.
    state = readRunState(projectDir, runId);
    if (
      iterationDispatchedIds.length > 0
      && collectGateRuntimeFacts(sorted, state, projectDir, runId).rejectedGateIds.length === 0
      && sorted.some((stage) => (
        isPendingStageStatus(state.stages[stage.id]?.status ?? '')
        && !(stage.retry_to?.length && !stage.is_gate)
      ))
    ) {
      const beforeContinuation = JSON.stringify(Object.fromEntries(
        sorted.map((stage) => [stage.id, [state.stages[stage.id]?.status, state.stages[stage.id]?.attempts?.length ?? 0]]),
      ));
      await executeIteration(
        sorted, projectDir, runId, runDirPath, workflow, adapter, agents,
        resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries,
        skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
      );
      state = readRunState(projectDir, runId);
      const afterContinuation = JSON.stringify(Object.fromEntries(
        sorted.map((stage) => [stage.id, [state.stages[stage.id]?.status, state.stages[stage.id]?.attempts?.length ?? 0]]),
      ));
      revisitRuntimeFacts = beforeContinuation !== afterContinuation;
    }
    }
  return {kind: 'continue', state, maxInnerRetries, innerRetriesUsed};
}
