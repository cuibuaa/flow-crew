// Boundary: Choose next iteration or truthful completion/failure from settled gates, required obligations and finite budgets; no stage execution.
import { Adapter } from '../../adapters/base.js';
import { recordRunEvent } from '../../run-events.js';
import { generateRunSummary } from '../../run-summary.js';
import { StageConfig } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { observeStableBlockage } from '../sched_policy/guidance.js';
import { isTerminalStatus } from '../sched_policy/identity.js';
import { allDone, anyFailed } from '../sched_scope/stage-group.js';
import { guardPlainCompletionWithStageObligations, reconcileUnresolvedStageObligations } from '../sched_settlement/completion.js';
import { archiveRejectedGateRuntimeFacts, canonicalGateRoundArtifactDir, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { loadGateContract } from '../sched_settlement/gate-contract.js';
import { collectGateRuntimeFacts, lastGatePassed } from '../sched_settlement/gate-recovery.js';
import { readGateVerdict } from '../sched_settlement/gate-verdict.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, enforceRealityGateBeforeTerminal, isPausedRunStatus, isPendingStageStatus, runDir, writeRunState, writeStageStatus } from '../../store.js';
import { createResearchBudgetFinalizer } from './research-terminal.js';
import { archiveDeclaredOutputsBeforePlainCompletion, concludeDeclaredTerminalAtQuiescence, concludeRepeatedBlockage, terminateForGateContractRefusal, writeCampaignEntry } from './services.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type IterationDisposition = {kind: 'settled' | 'next-iteration' | 'continue'; state: StoreState};
export async function concludeWorkflowIteration(
  state: StoreState, sorted: StageConfig[], iteration: number, iterationDispatchedIds: string[],
  innerRetriesUsed: number, maxIterations: number,
  finishResearchCeiling: ReturnType<typeof createResearchBudgetFinalizer>,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  injectedDispatchStages: Set<string>, planStageRetries: Map<string, number>,
): Promise<IterationDisposition> {
    // Check if last gate passed
    if (iterationDispatchedIds.length > 0 && !anyFailed(state) && lastGatePassed(state, iterationDispatchedIds, sorted, projectDir, runId)) {
      // A passed gate may request another phase while iteration budget remains.
      const pendingNextPhase = (() => {
        try {
          const gateStageIds = iterationDispatchedIds.filter((id) => {
            const stage = sorted.find((s) => s.id === id);
            return stage?.is_gate === true;
          });
          for (const gid of gateStageIds) {
            const vPath = join(runDir(projectDir, runId), `verdict_${gid}.json`);
            if (!existsSync(vPath)) continue;
            let v: Record<string, unknown>;
            try { v = JSON.parse(readFileSync(vPath, 'utf-8')); } catch { continue; }
            const phaseComplete = v.phaseComplete === true || v.phase_complete === true;
            const nextPhaseRaw = v.nextPhase ?? v.next_phase;
            const nextPhase = typeof nextPhaseRaw === 'string' ? nextPhaseRaw.trim() : '';
            if (phaseComplete && nextPhase) return { gateId: gid, nextPhase };
          }
        } catch { /* non-critical */ }
        return null;
      })();
      const unresolvedStageIds = guardPlainCompletionWithStageObligations(
        state,
        projectDir,
        runId,
        iteration,
        'gate_pass',
      );
      if (pendingNextPhase && iteration < maxIterations) {
        log.info({ runId, iteration, gate: pendingNextPhase.gateId, nextPhase: pendingNextPhase.nextPhase }, 'Gate passed with nextPhase set — continuing to next iteration instead of marking complete');
        return { kind: 'next-iteration', state };
      }
      // Research policy owns termination even when ordinary gates pass.
      if (state.research) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration }, 'Research run: gate passed but policy has not shipped/ceilinged — continuing (policy is sole terminal authority)');
          return { kind: 'next-iteration', state };
        }
        return { kind: 'settled', state: await finishResearchCeiling(
          state,
          iteration,
          'research ceiling: iteration budget exhausted without a policy ship/ceiling (insufficient measured rounds)',
          { stages: sorted, injectedDispatchStages, planStageRetries },
        ) };
      }
      // Terminal-state already handled by the top gate + eager post-batch gate
      // (with an isTerminalStatus early-return after executeIteration), so
      // reaching here means a plain gate-passed completion.
      if (unresolvedStageIds.length === 0) {
        return {kind: 'settled', state: await completePlainWorkflow(state, sorted, projectDir, runId, runDirPath, iteration, adapter, 'gate_pass')};
      }
    }

    // Completed execution is not gate acceptance: static gates use the same
    // effective authored/validation facts as dispatched gates.
    if (iterationDispatchedIds.length === 0 && !anyFailed(state) && allDone(state)
        && collectGateRuntimeFacts(sorted, state, projectDir, runId).allPass) {
      if (state.status === RUN_STATUS.FAILED) {
        writeCampaignEntry(projectDir, state);
        return { kind: 'settled', state };
      }
      // Research policy owns termination even when ordinary gates pass.
      if (state.research) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration }, 'Research run: no terminal from policy yet — continuing (policy is sole terminal authority)');
          return { kind: 'next-iteration', state };
        }
        return { kind: 'settled', state: await finishResearchCeiling(
          state,
          iteration,
          'research ceiling: iteration budget exhausted without a policy ship/ceiling (insufficient measured rounds)',
          { stages: sorted, injectedDispatchStages, planStageRetries },
        ) };
      }
      // Terminal-state already handled by the top + eager gates (see above).
      const unresolvedStageIds = guardPlainCompletionWithStageObligations(
        state,
        projectDir,
        runId,
        iteration,
        'base_all_done',
      );
      if (unresolvedStageIds.length === 0) {
        return {kind: 'settled', state: await completePlainWorkflow(state, sorted, projectDir, runId, runDirPath, iteration, adapter, 'base_all_done')};
      }
    }

    // Non-gate stage failure: if a stage failed and there are no gates to retry through,
    // fail immediately instead of silently re-planning
    const hasGates = sorted.some(s => s.is_gate);
    if (anyFailed(state) && !hasGates) {
      const failedStageIds = Object.entries(state.stages)
        .filter(([, s]) => s.status === STAGE_STATUS.FAILED)
        .map(([id]) => id);
      const details = failedStageIds.map(id => {
        const s = state.stages[id];
        return s?.error ? `${id} (${s.error})` : id;
      }).join(', ');
      state.status = RUN_STATUS.FAILED;
      state.failureReason = `Stage(s) failed: ${details}`;
      state.completedAt = new Date().toISOString();
      publishRunCompletion(state, projectDir, runId, () => ({iteration: iteration, detail: state.status}));
      log.info({ runId, iteration, failedStageIds }, 'Stage failed with no gates — run failed');
      return { kind: 'settled', state };
    }

    // Preserve a stable rejected verdict even when there is no repair stage or
    // the bounded repair loop is exhausted. Earlier retry-entry reads can be
    // transient while verdict/metric files are settling, so only the rejection
    // that survives the whole iteration earns a durable archive here.
    if (iterationDispatchedIds.length > 0) {
      const stableGateFacts = collectGateRuntimeFacts(sorted, state, projectDir, runId);
      if (stableGateFacts.evaluations.some((entry) => entry.rejectionKind === 'irreparable_rejection')
          && terminateForGateContractRefusal(state, stableGateFacts, projectDir, runId, iteration)) return { kind: 'settled', state };
      archiveRejectedGateRuntimeFacts(
        runDirPath,
        gateArchiveCoordinate(iteration, innerRetriesUsed + 1),
        stableGateFacts,
      );
      for (const evaluation of stableGateFacts.evaluations) {
        if (evaluation.effectiveVerdict?.pass !== false) continue;
        observeStableBlockage({
          runDirPath,
          kind: 'gate_rejection',
          stageId: evaluation.id,
          detail: evaluation.effectiveVerdict.reason ?? 'gate rejected without a reason',
          evidenceDigest: createHash('sha256')
            .update(JSON.stringify(evaluation.effectiveVerdict), 'utf8')
            .digest('hex'),
          repairDigest: (() => {
            if (innerRetriesUsed < 1) return undefined;
            const path = join(
              canonicalGateRoundArtifactDir(
                runDirPath,
                gateArchiveCoordinate(iteration, innerRetriesUsed),
              ),
              'repair_diff.json',
            );
            try {
              const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
              return createHash('sha256')
                .update(JSON.stringify(parsed.files ?? []), 'utf8')
                .digest('hex');
            } catch { return undefined; }
          })(),
          threshold: state.campaignTriggers?.repeatedFailureAfter,
        });
      }
      const repeatedGate = concludeRepeatedBlockage(
        state,
        { projectDir, runId, runDirPath, iteration },
      );
      if (repeatedGate) {
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return { kind: 'settled', state: repeatedGate };
      }
    }

    // Exhausted admitted work stops; only successful work advances above.
    {
      // Preserve an already settled terminal or parked state.
      if (isTerminalStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };
      const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
        state,
        sorted,
        { projectDir, runId, runDirPath, iteration, adapter },
        'max_iterations',
      );
      if (terminalConclusion) return { kind: 'settled', state: terminalConclusion };
      // A+(c): budget/iteration exhausted mid-search WITHOUT a clean exhaustive
      // ceiling is `incomplete` — distinct from `failed` (crash) and `ceiling_hit`
      // (honest negative). The search simply ran out of attempts.
      const activeDispatchedStages = Array.isArray(state.dispatchedStages)
        ? state.dispatchedStages as StageConfig[]
        : [];
      const unresolvedStageIds = reconcileUnresolvedStageObligations(
        state,
        activeDispatchedStages,
        state.currentIteration ?? iteration,
        runDirPath,
      ).stageIds;
      state.status = 'incomplete';
      state.failureReason = unresolvedStageIds.length > 0
        ? `Required stage obligation(s) remain unresolved: ${unresolvedStageIds.join(', ')}.`
        : `Workflow stopped after bounded stage/repair attempts: gates did not pass or required work did not complete (iteration ${iteration}).`;
      state.completedAt = new Date().toISOString();
      publishRunCompletion(state, projectDir, runId, () => ({iteration: iteration, detail: state.status}));
      log.info({ runId, iteration }, 'Admitted stage and repair attempts exhausted, run incomplete');
      return { kind: 'settled', state };
    }
}


export async function completePlainWorkflow(
  state: StoreState, stages: StageConfig[], projectDir: string, runId: string, runDirPath: string,
  iteration: number, adapter: Adapter, source: 'gate_pass' | 'base_all_done',
): Promise<StoreState> {
  const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
    state, stages, {projectDir, runId, runDirPath, iteration, adapter}, source,
  );
  if (terminalConclusion) return terminalConclusion;
  if (!archiveDeclaredOutputsBeforePlainCompletion(
    state, {projectDir, runId, runDirPath, iteration}, source,
  )) return state;
  state.status = RUN_STATUS.COMPLETE;
  state.completedAt = new Date().toISOString();
  const realityGate = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
  if (!realityGate.allowed) return realityGate.state;
  if (source === 'gate_pass') {
        // A retry stage that never ran because every related gate accepted the
        // work has a truthful terminal disposition: skipped, not indefinitely
        // pending and not falsely complete.
        const terminalContract = loadGateContract(projectDir, runId, state.campaignStorageKey);
        const stageById = new Map(stages.map((stage) => [stage.id, stage]));
        for (const repair of stages) {
          if (repair.is_gate || !repair.retry_to?.length) continue;
          const repairStatus = state.stages[repair.id];
          if (!repairStatus || !isPendingStageStatus(repairStatus.status)) continue;
          const relatedGates = repair.retry_to
            .map((gateId) => stageById.get(gateId))
            .filter((gate): gate is StageConfig => gate?.is_gate === true);
          const allRelatedGatesPassed = relatedGates.length === repair.retry_to.length
            && relatedGates.every((gate) => (
              state.stages[gate.id]?.status === STAGE_STATUS.COMPLETE
              && readGateVerdict(projectDir, gate.id, runId, terminalContract)?.pass === true
            ));
          if (!allRelatedGatesPassed) continue;
          const skipped = { ...repairStatus, status: STAGE_STATUS.SKIPPED };
          state.stages[repair.id] = skipped;
          writeStageStatus(projectDir, runId, repair.id, skipped);
        }

  }
  publishRunCompletion(state, projectDir, runId, () => ({iteration: iteration, detail: state.status}));
  if (source === 'gate_pass') {
    log.info({runId, iteration}, 'All gates passed, run complete');
  }
  await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
  return state;
}


// Publication order is shared; callers set the truthful terminal state first.
export function publishRunCompletion(
  state: StoreState, projectDir: string, runId: string,
  eventFields: () => {iteration: number | undefined; detail: string | undefined},
): void {
  writeRunState(projectDir, runId, state);
  writeCampaignEntry(projectDir, state);
  recordRunEvent(projectDir, runId, {
    type: 'run_completed', runId, timestamp: state.completedAt!, ...eventFields(),
  });
}
