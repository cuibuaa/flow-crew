// Boundary: Reconcile exact-ID outstanding obligations, guard plain completion, archive declared outputs and read existing study completion; receives only campaign publication.
import { archiveDeclaredOutputs } from '../../declared-output-archive.js';
import { recordRunEvent } from '../../run-events.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, runDir, writeRunState } from '../../store.js';
import { StageConfig } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { orderedGateIdsForState } from '../sched_policy/campaign.js';
import { scopePlanningDigestsBlockingStage, scopePlanningDispositionDigests } from '../sched_scope/scope-planning.js';
import { readTerminalStudyCompletionEvidence, writeTerminalStudyCompletionArtifacts } from './gate-verdict.js';

export function reconcileUnresolvedStageObligations(
  state: StoreState,
  dispatchedStages: readonly StageConfig[],
  declaredIteration: number,
  runDirPath: string,
): { changed: boolean; stageIds: string[] } {
  const before = state.unresolvedStageObligations ?? [];
  const obligations = new Map(before.map((entry) => [entry.stageId, entry]));
  const disposedScopeDigests = scopePlanningDispositionDigests(runDirPath);

  // An obligation is discharged only by an engine-observed success or explicit
  // skip of the same stage ID. A planner may also use the existing, durable
  // scope-negotiation resolve/defer contract when that exact digest is what
  // blocked the old downstream stage. Missing and failed stages otherwise stay.
  for (const [stageId, obligation] of obligations) {
    const status = state.stages[stageId]?.status;
    if (status === STAGE_STATUS.COMPLETE || status === STAGE_STATUS.SKIPPED) {
      obligations.delete(stageId);
      continue;
    }
    if (
      obligation.scopePlanningDigests?.length
      && obligation.scopePlanningDigests.every((digest) => disposedScopeDigests.has(digest))
    ) {
      obligations.delete(stageId);
    }
  }

  for (const stage of dispatchedStages) {
    // Conditional stages and retry_to repair stages are optional by contract.
    // A repair is eligible only after its gate rejects; a passing gate must not
    // turn its intentionally pending repair into required downstream work.
    if (stage.condition?.trim() || (!stage.is_gate && stage.retry_to?.length)) continue;
    const status = state.stages[stage.id]?.status;
    if (status === STAGE_STATUS.PENDING || status === STAGE_STATUS.RUNNING) {
      const scopePlanningDigests = scopePlanningDigestsBlockingStage(runDirPath, stage.id, dispatchedStages);
      const existing = obligations.get(stage.id);
      if (!existing) {
        obligations.set(stage.id, {
          stageId: stage.id,
          declaredIteration,
          ...(scopePlanningDigests.length > 0 ? { scopePlanningDigests } : {}),
        });
      } else if (scopePlanningDigests.length > 0) {
        obligations.set(stage.id, {
          ...existing,
          scopePlanningDigests: [...new Set([
            ...(existing.scopePlanningDigests ?? []),
            ...scopePlanningDigests,
          ])].sort(),
        });
      }
    }
  }

  const next = [...obligations.values()].sort((a, b) => (
    a.declaredIteration - b.declaredIteration || a.stageId.localeCompare(b.stageId)
  ));
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (next.length > 0) state.unresolvedStageObligations = next;
  else state.unresolvedStageObligations = undefined;
  return { changed, stageIds: next.map((entry) => entry.stageId) };
}

export function guardPlainCompletionWithStageObligations(
  state: StoreState,
  projectDir: string,
  runId: string,
  iteration: number,
  completionPath: string,
): string[] {
  const dispatched = Array.isArray(state.dispatchedStages)
    ? state.dispatchedStages as StageConfig[]
    : [];
  const reconciled = reconcileUnresolvedStageObligations(
    state,
    dispatched,
    state.currentIteration ?? iteration,
    runDir(projectDir, runId),
  );
  if (reconciled.changed) writeRunState(projectDir, runId, state);
  if (reconciled.stageIds.length > 0) {
    log.warn({
      runId,
      iteration,
      completionPath,
      unresolvedStageIds: reconciled.stageIds,
    }, 'Plain completion blocked by unresolved stage obligations');
  }
  return reconciled.stageIds;
}

export function appendUnresolvedStageObligationContext(prompt: string, state: StoreState): string {
  const obligations = state.unresolvedStageObligations ?? [];
  if (obligations.length === 0) return prompt;
  const rows = obligations.map((entry) => {
    const disposition = entry.scopePlanningDigests?.length
      ? `; alternatively record the pending scope disposition(s): ${entry.scopePlanningDigests.join(', ')}`
      : '';
    return `- ${entry.stageId} (declared in iteration ${entry.declaredIteration}${disposition})`;
  }).join('\n');
  return `${prompt}\n\n# Engine-owned unresolved stage obligations\n${rows}\n`
    + `A replacement plan cannot supersede these obligations by omission. Re-dispatch every exact stage ID above and let it reach complete or an explicit skipped disposition, unless the row names an existing scope-negotiation digest that this plan explicitly resolves or defers. `
    + `Until then, the engine will reject plain completion and will end incomplete if the iteration budget is exhausted.`;
}

export function recoverTerminalStudyCompletion(projectDir: string, runId: string, state: StoreState): StoreState | null {
  // This is an authored gate terminal contract, not a plain-complete exit. Like
  // brief terminal_states, it intentionally outranks unresolved DAG work.
  const gateIds = orderedGateIdsForState(projectDir, state);
  for (const gateId of gateIds) {
    const evidence = readTerminalStudyCompletionEvidence(projectDir, runId, gateId);
    if (!evidence) continue;
    writeTerminalStudyCompletionArtifacts(projectDir, runId, gateId, evidence);
    const next: StoreState = {
      ...state,
      status: RUN_STATUS.COMPLETE,
      completedAt: state.completedAt ?? new Date().toISOString(),
      campaignAlert: undefined,
      researchInjection: undefined,
      stages: { ...state.stages },
    };
    next.stages[gateId] = { ...(next.stages[gateId] ?? { retries: 0 }), status: STAGE_STATUS.COMPLETE, retries: next.stages[gateId]?.retries ?? 0 };
    for (const stage of (state.dispatchedStages ?? []) as StageConfig[]) {
      if (stage.retry_to?.includes(gateId) && next.stages[stage.id]) {
        next.stages[stage.id] = { ...next.stages[stage.id], status: STAGE_STATUS.SKIPPED };
      }
    }
    return next;
  }
  return null;
}

export function createPlainCompletionArchiver(writeCampaignEntry: (projectDir: string, state: StoreState) => void) {
  /** A successful run is the last reliable point at which ignored declared
   * outputs still exist in the worktree.  Archive them before committing every
   * non-terminal-state completion, and fail visibly if the declared artifact is
   * absent, ambiguous, or otherwise unsafe to preserve. */
  function archiveDeclaredOutputsBeforePlainCompletion(
    state: StoreState,
    context: { projectDir: string; runId: string; runDirPath: string; iteration: number },
    completionPath: string,
  ): boolean {
    if (!state.declaredOutputs?.length) return true;
    try {
      archiveDeclaredOutputs(context.projectDir, context.runDirPath, state.declaredOutputs);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      state.status = RUN_STATUS.FAILED;
      state.failureReason = `Declared output archival refused plain completion (${completionPath}): ${detail}`;
      state.completedAt = new Date().toISOString();
      writeRunState(context.projectDir, context.runId, state);
      writeCampaignEntry(context.projectDir, state);
      recordRunEvent(context.projectDir, context.runId, {
        type: 'run_completed',
        runId: context.runId,
        timestamp: state.completedAt,
        iteration: context.iteration,
        detail: state.failureReason,
        level: 'warning',
        source: 'scheduler',
      });
      log.error({ runId: context.runId, completionPath, detail }, 'Plain completion refused because declared outputs could not be archived');
      return false;
    }
  }
  return archiveDeclaredOutputsBeforePlainCompletion;
}
