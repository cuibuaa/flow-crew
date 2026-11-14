import { runRecordPath } from '../../run-layout.js';
// Boundary: Consume settled terminal signals and reset the iteration DAG with immutable obligation/evidence retirement and campaign identity.
import { Adapter } from '../../adapters/base.js';
import { resolveCampaignStorageKey } from '../../campaigns.js';
import { type StageConfig, normalizeStageContracts } from '../sched_admission/configuration.js';
import { restoreAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { log } from '../sched_admission/shared.js';
import { reconcileUnresolvedStageObligations } from '../sched_settlement/completion.js';
import { deriveCriterionDischarges } from '../sched_settlement/gate-verdict.js';
import { STAGE_STATUS, StoreState, isContinuingStage, captureStageEvidence, isTerminalRunStatus, readRunState, rependStageStatus, requireKnownRunStatus, runDir, writeRunState, writeStageStatus } from '../../store.js';
import { tryTerminateOnTerminalState } from './services.js';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Retain completed predecessors; unfinished slices invalidate their consumers. */
export function rependContinuingStages(state: StoreState, stages: StageConfig[], projectDir: string, runId: string): Set<string> {
  const reset = new Set(Object.entries(state.stages).filter(([, stage]) => isContinuingStage(stage)).map(([id]) => id));
  let added = true;
  while (added) {
    added = false;
    for (const stage of stages) if (!reset.has(stage.id) && stage.depends_on.some(id => reset.has(id))) {
      reset.add(stage.id); added = true;
    }
  }
  for (const id of reset) {
    state.stages[id] = rependStageStatus(state.stages[id], state.maxContinuations === undefined ? 0 : state.stages[id].retries);
    writeStageStatus(projectDir, runId, id, state.stages[id]);
  }
  writeRunState(projectDir, runId, state);
  return reset;
}

export async function prepareWorkflowIteration(
  iteration: number, resumeAtIteration: number, resumingExistingRun: boolean,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  baseStages: StageConfig[], workflowYaml: string,
): Promise<{kind: 'settled'; state: StoreState} | {
  kind: 'ready'; state: StoreState; sorted: StageConfig[];
  injectedDispatchStages: Set<string>;
}> {
    const isResumedIteration = resumingExistingRun && iteration === resumeAtIteration;
    let state = readRunState(projectDir, runId);
    const continuingBudget = Object.values(state.stages).some(isContinuingStage);
    requireKnownRunStatus(state.status, `execute scheduler iteration for run ${runId}`);

    // Exit if run was cancelled externally or already terminated
    if (isTerminalRunStatus(state.status)) {
      return { kind: 'settled', state };
    }

    // [Unified terminal gate, call site 1 of 2] Catch a terminal artifact
    // written by a PRIOR iteration (or present at start). Takes precedence
    // Floor-unmet retains its evaluation reasons and falls through.
    const terminalTop = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration, stages: baseStages });
    if (terminalTop.decision === 'matched') return { kind: 'settled', state: terminalTop.state };

    // Archive the shared scheduler/operator ledger between iterations so the
    // planner can read prior guidance without mixing it with current notices.
    if (iteration > 1 && !isResumedIteration) {
      try {
        const runDirAbs = runDir(projectDir, runId);
        const guidancePath = runRecordPath(runDirAbs, 'supervisor_guidance.md');
        if (existsSync(guidancePath)) {
          const archiveDir = runRecordPath(runDirAbs, 'guidance_history');
          mkdirSync(archiveDir, { recursive: true });
          renameSync(guidancePath, join(archiveDir, `iter_${iteration - 1}.md`));
        }
      } catch (err) {
        log.warn({ err, runId, iteration }, 'Failed to archive guidance');
      }
    }

    if (state.currentIteration !== iteration && !continuingBudget && !isResumedIteration && state.decisionGraph) state.decisionGraph.enabled = {};
    state.currentIteration = iteration;
    const campaignStorageKey = resolveCampaignStorageKey(state);
    if (campaignStorageKey) {
      state.campaignStorageKey = campaignStorageKey;
      state.campaignIteration = iteration;
    } else {
      state.campaignIteration = undefined;
    }
    writeRunState(projectDir, runId, state);

    // Build sorted stages for this iteration: start from base stages
    // A retired dynamic plan remains immutable history while its next planner
    // works. Only an active dispatch (or a complete static plan) is executable.
    const retainedPlan = state.planControl && (!state.planControl.stages.some(stage => stage.dynamic_dispatch)
      || Array.isArray(state.dispatchedStages)) ? state.planControl.stages : baseStages;
    const sorted: StageConfig[] = normalizeStageContracts((isResumedIteration || continuingBudget ? retainedPlan : baseStages).map(s => ({ ...s })));
    const injectedDispatchStages = new Set<string>();
    if ((isResumedIteration || continuingBudget) && state.planControl) for (const stage of sorted) if (stage.dynamic_dispatch && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE) injectedDispatchStages.add(stage.id);
    // Admission refusal accounting remains run-wide across iterations.

    // Delete dispatch.yaml before plan stage runs only on re-plan (iteration > 1)
    const dispatchPathPre = runRecordPath(runDirPath, 'dispatch.yaml');
    if (iteration > 1 && !isResumedIteration && !continuingBudget && existsSync(dispatchPathPre)) unlinkSync(dispatchPathPre);
    if (iteration > 1 && !isResumedIteration && !continuingBudget && state.admittedRealityChecks) {
      restoreAdmittedRealityChecks(runDirPath, state);
    }

    // Reset all base stages to pending for this iteration
    state = readRunState(projectDir, runId);
    if (continuingBudget) {
      // Preserve the admitted DAG and completed predecessors. Only unfinished
      // slices and their consumers need execution; no optional session is needed.
      for (const id of rependContinuingStages(state, sorted, projectDir, runId)) injectedDispatchStages.delete(id);
    }
    // An ordinary re-plan retires the old DAG; a budget boundary retains it.
    if (iteration > 1 && !isResumedIteration && !continuingBudget) {
      // Persist required work before retiring the old dynamic DAG. The retired
      // usage ledger preserves cost/history; this separate ledger preserves the
      // fact that a pending/running required stage was never fulfilled.
      const previousDispatchedStages = Array.isArray(state.dispatchedStages)
        ? state.dispatchedStages as StageConfig[]
        : [];
      reconcileUnresolvedStageObligations(
        state,
        previousDispatchedStages,
        Math.max(1, iteration - 1),
        runDirPath,
      );
      // Materialize immutable evidence for every old dynamic stage before the
      // single run.json write that replaces the active DAG. The archive files
      // exist first; the atomic state write below then publishes their paths and
      // the deletion together, so no persisted state can point at missing proof.
      const baseIds = new Set(baseStages.map(s => s.id));
      const retiringStageIds = Object.keys(state.stages).filter((sid) => !baseIds.has(sid));
      const retiredIteration = Math.max(1, iteration - 1);
      const capturedEvidence = retiringStageIds.map((sid) => captureStageEvidence(
        projectDir,
        runId,
        retiredIteration,
        sid,
        state.stages[sid],
      ));
      state.stageEvidence ??= [];
      for (const evidence of capturedEvidence) {
        if (!state.stageEvidence.some((entry) =>
          entry.iteration === evidence.iteration && entry.stageId === evidence.stageId)) {
          state.stageEvidence.push(evidence);
        }
      }
      const newlyDischarged = deriveCriterionDischarges({
        projectDir,
        runId,
        runDirPath,
        iteration: retiredIteration,
        stages: previousDispatchedStages,
        state,
        evidence: capturedEvidence,
      });
      state.criterionDischarges ??= [];
      for (const discharge of newlyDischarged) {
        if (!state.criterionDischarges.some((existing) =>
          existing.briefDigest === discharge.briefDigest
          && existing.criterionId === discharge.criterionId)) {
          state.criterionDischarges.push(discharge);
        }
      }
      for (const sid of retiringStageIds) {
        delete state.stages[sid];
      }
      // Engineering iterations reset their static stage projections; research
      // submission settlement is owned by the measurement loop.
      for (const s of baseStages) {
        state.stages[s.id] = rependStageStatus(state.stages[s.id], 0);
        mkdirSync(runRecordPath(runDirPath, 'stages', s.id), { recursive: true });
      }
      state.dispatchedStages = undefined;
      state.status = 'running';
      writeRunState(projectDir, runId, state);

      // Clean stale verdict files from previous iteration so new gates start fresh
      try {
        for (const f of readdirSync(runRecordPath(runDirPath, '.'))) {
          if (f.startsWith('verdict') && f.endsWith('.json')) {
            unlinkSync(runRecordPath(runDirPath, f));
          }
        }
      } catch { /* best effort */ }

      // Re-write workflow.yaml to base stages only
      writeFileSync(runRecordPath(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }
  return {kind: 'ready', state, sorted, injectedDispatchStages};
}
