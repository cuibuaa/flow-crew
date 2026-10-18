import { publishRunCompletion } from '../sched_policy/run-completion.js';
// Boundary: Own bounded gate repair and re-evaluation cycles from fresh runtime facts; resume admitted successors and required rework without bypassing rejection.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { StageConfig, WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { captureRepairRoundSnapshot } from '../sched_scope/snapshots.js';
import { syncStageStatuses } from '../sched_scope/stage-group.js';
import { archiveGateRoundEvidence, archiveRejectedGateRuntimeFacts, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { classifyGateRecoveryFact, collectGateRuntimeFacts, findGateRecoveryStages, gateIdsForRecoveryStages, gateRetryDiagnosticSnapshot } from '../sched_settlement/gate-recovery.js';
import { executeSingleStage } from '../sched_settlement/stage-execution.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, isContinuingStage, isPausedRunStatus, isPendingStageStatus, isTerminalRunStatus, readRunState, rependStageStatus, writeRunState } from '../../store.js';
import { readRunValidationBaseline, settleGateValidationEvidence } from '../sched_settlement/gate-validation.js';
import { executeIteration } from './iteration.js';
import { consumePlanRevisions, findAllReady, runScopeSafeStageGroup, terminateForGateContractRefusal, writeRepairRoundDiffArtifact } from './services.js';
import { mkdirSync, unlinkSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parkAtDeploymentBoundary } from '../../deployment-hold.js';

export async function settleGateRetries(
  state: StoreState, sorted: StageConfig[], iteration: number,
  injectedDispatchStages: Set<string>,
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
    const held = parkAtDeploymentBoundary(projectDir, runId);
    if (held) return { kind: 'settled', state: held };
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = Math.max(0, Math.floor(Number(
      state.maxRetries ?? loadDefaults().gate_retry_loops,
    )));
    let innerRetriesUsed = 0;
    // Completed rounds already own durable evidence. Resume the same budget
    // and archive coordinates after a park instead of granting fresh repairs.
    const retryArchive = join(runDirPath, 'gate_reevaluation', `iteration_${iteration}`);
    if (existsSync(retryArchive)) for (const name of readdirSync(retryArchive)) {
      const round = /^round_(\d+)$/.exec(name);
      if (round && existsSync(join(retryArchive, name, 'repair_diff.json'))) {
        innerRetriesUsed = Math.max(innerRetriesUsed, Number(round[1]));
      }
    }
    // Pending attempted repair remains admitted work. Continue its unfinished
    // round without repeating completed companions or restoring the budget.
    const resumedRepairStages = sorted.filter(stage => {
      const status = state.stages[stage.id], attempt = status?.attempts?.at(-1);
      return !stage.is_gate && stage.retry_to?.length && isPendingStageStatus(status?.status ?? '')
        && attempt && (attempt.iteration === undefined || attempt.iteration === iteration);
    });
    let resumedRepairRound = resumedRepairStages.length ? Math.max(1, innerRetriesUsed) : undefined;
    if (resumedRepairRound && innerRetriesUsed > 0) {
      try {
        const receipt = JSON.parse(readFileSync(join(retryArchive, `round_${innerRetriesUsed}`, 'repair_diff.json'), 'utf8'));
        if (resumedRepairStages.some(stage => Date.parse(state.stages[stage.id].attempts!.at(-1)!.startedAt) > Date.parse(receipt.completedAt)
          || (Array.isArray(receipt.repairStageIds) && !receipt.repairStageIds.includes(stage.id)))) resumedRepairRound++;
      } catch { /* Legacy receipts retain their recorded round. */ }
      if (resumedRepairRound === innerRetriesUsed) innerRetriesUsed--;
    }
    let revisitRuntimeFacts = true;
    const budgetPending = () => Object.values(state.stages).some(isContinuingStage);
    while (revisitRuntimeFacts) {
    revisitRuntimeFacts = false;
    state = readRunState(projectDir, runId);
    if (budgetPending()) return { kind: 'continue', state, maxInnerRetries, innerRetriesUsed };
      // Gate and retry_to topology owns verification for every admitted plan.
      if (readRunValidationBaseline(runDirPath)) {
        for (const gate of sorted.filter((stage) => stage.is_gate && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE && !state.stages[stage.id]?.acceptedFrom)) {
          const validation = await settleGateValidationEvidence(projectDir, runId, gate.id);
          state = readRunState(projectDir, runId);
          if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };
          if (validation.kind === 'refused') {
            state.status = RUN_STATUS.FAILED;
            state.failureReason = validation.reason;
            state.completedAt = new Date().toISOString();
            publishRunCompletion(state, projectDir, runId, () => ({ iteration, detail: validation.reason }));
            return { kind: 'settled', state };
          }
        }
      }
      const outerCheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
      if (outerCheck.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
          && terminateForGateContractRefusal(state, outerCheck, projectDir, runId, iteration)) return { kind: 'settled', state };
      const { allPass, failedGateIds, rejectedGateIds } = outerCheck;
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
      if (!allPass || resumedRepairStages.length > 0) {
        // New repair needs a validated rejection; unfinished admitted work
        // retains its eligibility through execution or settlement failure.
        const retryStages = resumedRepairStages.length ? resumedRepairStages : findGateRecoveryStages(
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
          for (let inner = innerRetriesUsed; inner < maxInnerRetries || inner + 1 === resumedRepairRound; inner++) {

            // Check for cancellation between retries
            state = readRunState(projectDir, runId);
            const heldAtRound = parkAtDeploymentBoundary(projectDir, runId);
            if (heldAtRound) return { kind: 'settled', state: heldAtRound };
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
            const resumingRepair = inner + 1 === resumedRepairRound;
            const breakConditions = { allPass: currentCheck.allPass, repairSettled: !resumingRepair };
            const shouldBreakForPassingGates = breakConditions.allPass && breakConditions.repairSettled;
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

            const activeRecoveryStages = resumingRepair ? resumedRepairStages : findGateRecoveryStages(
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
            const activeGateIds = resumingRepair
              ? sorted.filter(stage => stage.is_gate && resumedRepairStages.some(repair => repair.retry_to?.includes(stage.id))).map(stage => stage.id)
              : gateIdsForRecoveryStages(
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
            if (dispatchCheck.allPass && !resumingRepair) {
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

            // A repair can append admitted work at this same closed-child
            // boundary. Finish that work before asking the gate to review it;
            // it continues this round, without another repair-budget grant.
            let repairBatch = activeWorkRecoveryStages.slice();
            let workBlocked = false;
            innerRetriesUsed = inner + 1;
            // Reset the whole round before computing readiness. Otherwise an
            // earlier round's COMPLETE dependency can release its successor.
            for (const retryStage of repairBatch) {
              state.stages[retryStage.id] = rependStageStatus(state.stages[retryStage.id], 0);
            }
            writeRunState(projectDir, runId, state);
            while (repairBatch.length > 0) {
              // Only retry edges are satisfied by the existing rejection.
              // Ordinary dependencies must finish in this round first.
              const readyIds = new Set(findAllReady(repairBatch.map(stage => ({
                ...stage, retry_to: [], depends_on: stage.depends_on.filter(id => !stage.retry_to?.includes(id)),
              })), state).map(stage => stage.id));
              const ready = repairBatch.filter(stage => readyIds.has(stage.id));
              if (ready.length === 0) { workBlocked = true; break; }
              for (const retryStage of ready) {
                mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
              }

              // The runner captures fresh guard preimages for each disjoint
              // wave, including serialized scopes. The round snapshot above
              // belongs only to the combined review diff.
              await runScopeSafeStageGroup(
                ready,
                projectDir,
                runId,
                state.currentIteration ?? 1,
                (retryStage, liveConstraintGuardFactory, settlementBoundary) => executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, undefined, undefined, availableSkillsList, attemptDeadlineClockFactory, liveConstraintGuardFactory, settlementBoundary),
                repairSnapshot,
              );
              syncStageStatuses(projectDir, runId, ready.map(s => s.id));
              state = readRunState(projectDir, runId);
              if (isPausedRunStatus(state.status)) return { kind: 'settled', state };
              if (budgetPending() || isTerminalRunStatus(state.status)
                || ready.some(stage => state.stages[stage.id]?.status === STAGE_STATUS.FAILED)) break;
              repairBatch = repairBatch.filter(stage => !readyIds.has(stage.id));
              // Initial plan admission belongs to the ordinary loop. A repair
              // boundary can amend only a plan that was already admitted.
              if (state.planControl) state = consumePlanRevisions(sorted, state, projectDir, runId, runDirPath, workflow, roleRegistry);
              if (isTerminalRunStatus(state.status)) break;
              const extensions = sorted.filter(stage => !stage.is_gate
                && stage.retry_to?.some(id => activeGateSet.has(id)) && isPendingStageStatus(state.stages[stage.id]?.status ?? '')
                && !(state.stages[stage.id]?.attempts?.length)
                && !activeWorkRecoveryStages.some(active => active.id === stage.id));
              for (const next of extensions) {
                activeWorkRecoveryStages.push(next);
                repairBatch.push(next);
              }
            }
            const roundDiffPath = writeRepairRoundDiffArtifact({
              snapshot: repairSnapshot,
              projectDir,
              runDirPath,
              iteration,
              round: repairRound,
              repairStages: activeWorkRecoveryStages,
              statuses: state.stages,
            });

            if (budgetPending() || workBlocked) return { kind: 'continue', state, maxInnerRetries, innerRetriesUsed };

            // Check for cancellation after fix stages complete
            if (isTerminalRunStatus(state.status)) break;

            // Skip gate re-runs if any fix stage itself failed (saves wasted agent calls)
            const anyFixFailed = activeWorkRecoveryStages.some(s => state.stages[s.id]?.status === STAGE_STATUS.FAILED);
            if (anyFixFailed) {
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
              // Keep any structured correction until gate continuation choice:
              // gateContinuationSessionForStage consumes it exactly once and
              // cold-starts the re-evaluation when prior reasoning was wrong.
              state.stages[gate.id] = rependStageStatus(state.stages[gate.id], 0);
              mkdirSync(join(runDirPath, 'stages', gate.id), { recursive: true });
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
                (gate, liveConstraintGuardFactory, settlementBoundary) => executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, activeWorkRecoveryStages.map(s => s.id), roundDiffPath, availableSkillsList, attemptDeadlineClockFactory, liveConstraintGuardFactory, settlementBoundary),
              );
              syncStageStatuses(projectDir, runId, gatesToRerun.map(s => s.id));
            }
            state = readRunState(projectDir, runId);
            if (isPausedRunStatus(state.status)) return { kind: 'settled', state };
            if (budgetPending()) return { kind: 'continue', state, maxInnerRetries, innerRetriesUsed };

            // Check gates again
            const recheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
            if (recheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, inner + 2),
                recheck,
              );
            }
            if (recheck.allPass) break;
            if (inner === maxInnerRetries - 1) {
              log.info({ runId, iteration }, 'Bounded repair loop exhausted');
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
      collectGateRuntimeFacts(sorted, state, projectDir, runId).rejectedGateIds.length === 0
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
      if (isPausedRunStatus(state.status) || isTerminalRunStatus(state.status)) return { kind: 'settled', state };
      const afterContinuation = JSON.stringify(Object.fromEntries(
        sorted.map((stage) => [stage.id, [state.stages[stage.id]?.status, state.stages[stage.id]?.attempts?.length ?? 0]]),
      ));
      revisitRuntimeFacts = beforeContinuation !== afterContinuation;
    }
    }
  return {kind: 'continue', state, maxInnerRetries, innerRetriesUsed};
}
