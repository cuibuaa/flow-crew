import { completePlainWorkflow } from './iteration-outcome.js';
// Boundary: Consume settled supervisor/terminal signals and reset the iteration DAG with immutable obligation/evidence retirement and campaign health projections.
import { Adapter } from '../../adapters/base.js';
import { readCampaignEntries, resolveCampaignStorageKey } from '../../campaigns.js';
import { RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { markDeadEnd, readKG } from '../../knowledge-graph.js';
import { readRunEvents, recordRunEvent } from '../../run-events.js';
import { generateRunSummary } from '../../run-summary.js';
import { StageConfig } from '../sched_admission/configuration.js';
import { restoreAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { log } from '../sched_admission/shared.js';
import { SupervisorReplanFreshness, evaluateSupervisorReplanFreshness, reconcileSupervisorReplan, supervisorReplanSignalV2 } from '../sched_admission/supervisor-replan.js';
import { checkCampaignHealth } from '../sched_policy/campaign.js';
import { appendSchedulerGuidanceOnce } from '../sched_policy/guidance.js';
import { guardPlainCompletionWithStageObligations, reconcileUnresolvedStageObligations } from '../sched_settlement/completion.js';
import { deriveCriterionDischarges } from '../sched_settlement/gate-verdict.js';
import { STAGE_STATUS, StoreState, captureStageEvidence, isTerminalRunStatus, readRunState, rependStageStatus, requireKnownRunStatus, runDir, writeRunState } from '../../store.js';
import { concludeRepeatedBlockage, tryParkOnApprovalRequest, tryTerminateOnTerminalState } from './services.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function prepareWorkflowIteration(
  iteration: number, resumeAtIteration: number, resumingFromPark: boolean,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  baseStages: StageConfig[], workflowYaml: string,
): Promise<{kind: 'settled'; state: StoreState} | {
  kind: 'ready'; state: StoreState; sorted: StageConfig[];
  injectedDispatchStages: Set<string>; planStageRetries: Map<string, number>;
}> {
    const isResumedIteration = resumingFromPark && iteration === resumeAtIteration;
    let state = readRunState(projectDir, runId);
    requireKnownRunStatus(state.status, `execute scheduler iteration for run ${runId}`);

    // Exit if run was cancelled externally or already terminated
    if (isTerminalRunStatus(state.status)) {
      return { kind: 'settled', state };
    }

    const repeatedBlockage = concludeRepeatedBlockage(
      state,
      { projectDir, runId, runDirPath, iteration },
    );
    if (repeatedBlockage) {
      await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
      return { kind: 'settled', state: repeatedBlockage };
    }

    // [Unified terminal gate, call site 1 of 2] Catch a terminal artifact
    // written by a PRIOR iteration (or present at start). Takes precedence
    // over supervisor-DONE below. Floor-unmet writes a hint and falls through.
    // [Approval park gate, call site 1 of 2] An unresolved approval request
    // written by a previous iteration (or still unresolved at relaunch) parks
    // again instead of re-executing the consequential action.
    const parkedTop = await tryParkOnApprovalRequest(state, { projectDir, runId, runDirPath, iteration });
    if (parkedTop) return { kind: 'settled', state: parkedTop };

    const terminalTop = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration, adapter });
    if (terminalTop.decision === 'matched') return { kind: 'settled', state: terminalTop.state };

    // Honor supervisor DONE: if `signals/goal_met.json` exists at the top of
    // any iteration after the first, the supervisor has judged the original
    // goal fully met by prior-iteration evidence. Mark the run complete and
    // exit the loop instead of burning more iterations on incremental gains.
    // Iteration 1 cannot reference prior evidence, so we skip the check there.
    //
    // Research mode is EXEMPT: termination is owned by the research policy
    // (ship on `beat`, ceiling on max_rounds/no-improvement) — not by the
    // supervisor's "goal met" heuristic. Otherwise the supervisor mistakes a
    // single compliant round (e.g. "Tier 1 audit passed") for the whole
    // exhaustive search being done and ends the loop prematurely.
    if (iteration > 1 && !state.research) {
      const goalMetPath = join(runDir(projectDir, runId), 'signals', 'goal_met.json');
      if (existsSync(goalMetPath)) {
        let goalReason = 'Supervisor signaled DONE (signals/goal_met.json present)';
        try {
          const sig = JSON.parse(readFileSync(goalMetPath, 'utf-8')) as { reason?: string };
          if (sig.reason) goalReason = `Supervisor DONE: ${sig.reason}`;
        } catch { /* malformed; keep generic reason */ }
        // Terminal-state already took precedence at the top-of-iteration gate
        // above (call site 1), so reaching here means no terminal artifact —
        // a plain supervisor-DONE completion.
        const unresolvedStageIds = guardPlainCompletionWithStageObligations(
          state,
          projectDir,
          runId,
          iteration,
          'supervisor_goal_met',
        );
        if (unresolvedStageIds.length === 0) {
          return {kind: 'settled', state: await completePlainWorkflow(state, [
              ...baseStages,
              ...(Array.isArray(state.dispatchedStages) ? state.dispatchedStages as StageConfig[] : []),
            ], projectDir, runId, runDirPath, iteration, adapter, 'supervisor_goal_met', goalReason)};
        }
      }
    }

    // (Terminal-state detection consolidated to the unified gate at the top of
    // this iteration loop + the eager post-batch check inside executeIteration.
    // The previous inline duplicate here was removed.)

    // Bug ② fix: archive the previous iteration's accumulated supervisor
    // guidance so this iteration starts with an empty `supervisor_guidance.md`.
    // The archived file under `guidance_history/iter_${N-1}.md` is later
    // injected into the planner's system prompt by worker.ts, so prior-iter
    // GUIDE messages still impact this iteration's plan — but they no longer
    // mix with this iteration's fresh GUIDE messages in the same file.
    if (iteration > 1 && !isResumedIteration) {
      try {
        const runDirAbs = runDir(projectDir, runId);
        const guidancePath = join(runDirAbs, 'supervisor_guidance.md');
        if (existsSync(guidancePath)) {
          const archiveDir = join(runDirAbs, 'guidance_history');
          mkdirSync(archiveDir, { recursive: true });
          renameSync(guidancePath, join(archiveDir, `iter_${iteration - 1}.md`));
        }
      } catch (err) {
        log.warn({ err, runId, iteration }, 'Failed to archive supervisor guidance');
      }
    }

    // Honor supervisor REPLAN: the supervisor judged the current approach
    // fundamentally wrong and wrote signals/replan.json (previously a DEAD signal
    // — written, never read). Consume it and inject a hard-pivot hint into this
    // iteration's fresh guidance so the re-plan avoids the rejected approach. The
    // signal is one-shot (deleted on consume) and bounded by maxIterations.
    if (iteration > 1) {
      const replanPath = join(runDir(projectDir, runId), 'signals', 'replan.json');
      if (existsSync(replanPath)) {
        let replanReason = 'supervisor judged the approach fundamentally wrong';
        let replanSignal: unknown = {};
        try {
          const sig = JSON.parse(readFileSync(replanPath, 'utf-8')) as { reason?: string };
          replanSignal = sig;
          if (sig.reason) replanReason = sig.reason;
        } catch { /* malformed; keep generic reason */ }
        const events = readRunEvents(projectDir, runId);
        const allKnownStages = [
          ...baseStages,
          ...((Array.isArray(state.dispatchedStages) ? state.dispatchedStages : []) as StageConfig[]),
        ];
        const uniqueStages = [...new Map(allKnownStages.map((stage) => [stage.id, stage])).values()];
        const signalTimestamp = replanSignal && typeof replanSignal === 'object'
          && typeof (replanSignal as { timestamp?: unknown }).timestamp === 'string'
          ? String((replanSignal as { timestamp: string }).timestamp)
          : undefined;
        const passedGateIds = uniqueStages.flatMap((stage) => {
          if (!stage.is_gate) return [];
          let passed = false;
          try {
            const verdict = JSON.parse(readFileSync(join(runDirPath, `verdict_${stage.id}.json`), 'utf-8')) as { pass?: unknown };
            passed = verdict.pass === true;
          } catch { /* not an accepted gate */ }
          if (!passed) return [];
          const acceptedAfterSignal = !signalTimestamp || events.some((event) => (
            event.type === 'stage_complete'
            && event.stageId === stage.id
            && Date.parse(event.timestamp) > Date.parse(signalTimestamp)
          ));
          return acceptedAfterSignal ? [stage.id] : [];
        });
        let supervisorState: unknown;
        let supervisorLog: string | undefined;
        try { supervisorState = JSON.parse(readFileSync(join(runDirPath, 'supervisor_state.json'), 'utf-8')); } catch { /* absent legacy state */ }
        try { supervisorLog = readFileSync(join(runDirPath, 'supervisor_log.md'), 'utf-8'); } catch { /* absent legacy log */ }
        const reconciled = reconcileSupervisorReplan({
          signal: replanSignal,
          events,
          supervisorState,
          supervisorLog,
        });
        const evaluatedFreshness = evaluateSupervisorReplanFreshness({
          signal: reconciled.signal,
          events: reconciled.events,
          stages: uniqueStages,
          passedGateIds,
        });
        const freshness: SupervisorReplanFreshness = (
          reconciled.identitySource === 'supervisor_state' || reconciled.identitySource === 'supervisor_log'
        ) ? { ...evaluatedFreshness, signalVersion: 'legacy_resolved' } : evaluatedFreshness;
        try { unlinkSync(replanPath); } catch { /* already consumed */ }
        const structuredSignal = supervisorReplanSignalV2(reconciled.signal);
        if (freshness.decision === 'replay') {
          appendSchedulerGuidanceOnce(
            runDir(projectDir, runId),
            RUN_WIDE_GUIDANCE_TARGET,
            `[supervisor-replan:iteration-${iteration}]`,
            `⚠️ PIVOT REQUIRED (supervisor REPLAN): ${replanReason}\nThe previous approach was judged fundamentally wrong. Plan a materially DIFFERENT approach; do not repeat the rejected direction.`,
          );
          recordRunEvent(projectDir, runId, {
            type: 'supervisor_replan', runId, timestamp: new Date().toISOString(), iteration,
            stageId: structuredSignal?.targetStage,
            attemptIndex: structuredSignal?.attemptIndex,
            attemptStartedAt: structuredSignal?.attemptStartedAt,
            assessmentId: structuredSignal?.assessmentId,
            evidenceIds: structuredSignal?.evidenceIds,
            decision: 'accepted',
            detail: replanReason,
            source: 'scheduler',
          });
          log.info({ runId, iteration, replanReason, freshness, identitySource: reconciled.identitySource }, 'Supervisor REPLAN consumed; pivot hint injected for this iteration plan');
        } else {
          recordRunEvent(projectDir, runId, {
            type: 'supervisor_replan', runId, timestamp: new Date().toISOString(), iteration,
            stageId: structuredSignal?.targetStage,
            attemptIndex: structuredSignal?.attemptIndex,
            attemptStartedAt: structuredSignal?.attemptStartedAt,
            assessmentId: structuredSignal?.assessmentId,
            evidenceIds: structuredSignal?.evidenceIds,
            decision: 'discarded',
            detail: `stale REPLAN discarded: ${freshness.reason}; original reason: ${replanReason}`,
            source: 'scheduler',
          });
          log.info({ runId, iteration, replanReason, freshness, identitySource: reconciled.identitySource }, 'Stale supervisor REPLAN discarded before planner guidance');
        }
      }
    }

    state.currentIteration = iteration;
    const campaignStorageKey = resolveCampaignStorageKey({
      campaignId: state.campaignId,
      campaignStorageKey: state.campaignStorageKey,
      campaignName: state.campaignName,
    });
    if (campaignStorageKey) {
      state.campaignStorageKey = campaignStorageKey;
      state.campaignIteration = iteration;
    } else {
      state.campaignIteration = undefined;
    }
    writeRunState(projectDir, runId, state);

    // Build sorted stages for this iteration: start from base stages
    const sorted: StageConfig[] = (isResumedIteration && state.planControl ? state.planControl.stages : baseStages).map(s => ({ ...s }));
    const injectedDispatchStages = new Set<string>();
    if (isResumedIteration && state.planControl) for (const stage of sorted) if (stage.dynamic_dispatch && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE) injectedDispatchStages.add(stage.id);
    // Planner retry counters are bounded within this iteration.
    const planStageRetries = new Map<string, number>();

    // Delete dispatch.yaml before plan stage runs only on re-plan (iteration > 1)
    const dispatchPathPre = join(runDirPath, 'dispatch.yaml');
    if (iteration > 1 && !isResumedIteration && existsSync(dispatchPathPre)) unlinkSync(dispatchPathPre);
    if (iteration > 1 && !isResumedIteration && state.admittedRealityChecks) {
      restoreAdmittedRealityChecks(runDirPath, state);
    }

    // Reset all base stages to pending for this iteration
    state = readRunState(projectDir, runId);
    // On iteration 2+, reset base stage statuses and clear old dispatched stages
    if (iteration > 1 && !isResumedIteration) {
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
      state.retiredStageUsage ??= [];
      for (const evidence of capturedEvidence) {
        if (!state.stageEvidence.some((entry) =>
          entry.iteration === evidence.iteration && entry.stageId === evidence.stageId)) {
          state.stageEvidence.push(evidence);
        }
        state.retiredStageUsage.push({
          stageId: evidence.stageId,
          iteration: evidence.iteration,
          status: evidence.status,
        });
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
      if (state.criterionDischarges.length > 0) {
        writeFileSync(join(runDirPath, 'criterion_discharges.json'), `${JSON.stringify({
          version: 1,
          records: state.criterionDischarges,
        }, null, 2)}\n`, 'utf-8');
      }
      for (const sid of retiringStageIds) {
        delete state.stages[sid];
      }
      for (const s of baseStages) {
        state.stages[s.id] = rependStageStatus(state.stages[s.id], 0);
        mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
      }
      state.dispatchedStages = undefined;
      state.status = 'running';
      writeRunState(projectDir, runId, state);

      // Clean stale verdict files from previous iteration so new gates start fresh
      try {
        for (const f of readdirSync(runDirPath)) {
          if (f.startsWith('verdict') && f.endsWith('.json')) {
            unlinkSync(join(runDirPath, f));
          }
        }
      } catch { /* best effort */ }

      // Re-write workflow.yaml to base stages only
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }
    // Campaign health check: inject researcher if regression/plateau detected
    if (campaignStorageKey && iteration > 1) {
      const entries = readCampaignEntries(projectDir, campaignStorageKey);
      const triggers = state.campaignTriggers;
      const alert = checkCampaignHealth(entries, triggers);
      if (alert) {
        const triggeredAt = new Date().toISOString();
        state.campaignAlert = {
          ...alert,
          source: 'campaign_health',
          triggeredAt,
          iteration,
        };
        state.researchInjection = {
          source: 'campaign_health',
          triggeredAt,
          iteration,
          alertType: alert.type,
          message: alert.message,
        };
        writeRunState(projectDir, runId, state);
        recordRunEvent(projectDir, runId, {
          type: 'campaign_alert',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        recordRunEvent(projectDir, runId, {
          type: 'research_injected',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        log.info({ runId, alert: alert.type }, 'Campaign health alert — researcher will be injected via planner context');
        // Auto-mark current approach nodes as dead ends
        try {
          const kg = readKG(projectDir, runId);
          for (const node of kg.nodes.filter(n => n.type === 'approach')) {
            markDeadEnd(projectDir, runId, node.id, `Marked dead_end by campaign health: ${alert.message}`);
          }
        } catch { /* non-fatal */ }
      } else if (state.campaignAlert) {
        state.campaignAlert = undefined;
        writeRunState(projectDir, runId, state);
      }
    }
  return {kind: 'ready', state, sorted, injectedDispatchStages, planStageRetries};
}
