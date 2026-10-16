// Boundary: Consume settled terminal signals and reset the iteration DAG with immutable obligation/evidence retirement and campaign health projections.
import { createHash } from 'node:crypto';
import { resolveResearchPaths } from '../../research-paths.js';
import { stageScopeOwnsPath } from '../sched_admission/dispatch.js';
import { gateReviewedAuthorIds } from '../sched_settlement/gate-recovery.js';
import { readResearchGateCandidate } from '../../research-candidate.js';
import { Adapter } from '../../adapters/base.js';
import { readCampaignEntries, resolveCampaignStorageKey } from '../../campaigns.js';
import { recordRunEvent } from '../../run-events.js';
import { StageConfig } from '../sched_admission/configuration.js';
import { restoreAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { log } from '../sched_admission/shared.js';
import { checkCampaignHealth } from '../sched_policy/campaign.js';
import { reconcileUnresolvedStageObligations } from '../sched_settlement/completion.js';
import { deriveCriterionDischarges } from '../sched_settlement/gate-verdict.js';
import { STAGE_STATUS, StoreState, captureStageEvidence, isTerminalRunStatus, readRunState, rependStageStatus, requireKnownRunStatus, runDir, writeRunState } from '../../store.js';
import { concludeRepeatedBlockage, tryParkOnApprovalRequest, tryTerminateOnTerminalState } from './services.js';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export async function prepareWorkflowIteration(
  iteration: number, resumeAtIteration: number, resumingExistingRun: boolean,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  baseStages: StageConfig[], workflowYaml: string,
): Promise<{kind: 'settled'; state: StoreState} | {
  kind: 'ready'; state: StoreState; sorted: StageConfig[];
  injectedDispatchStages: Set<string>; planStageRetries: Map<string, number>;
}> {
    const isResumedIteration = resumingExistingRun && iteration === resumeAtIteration;
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
      return { kind: 'settled', state: repeatedBlockage };
    }

    // [Unified terminal gate, call site 1 of 2] Catch a terminal artifact
    // written by a PRIOR iteration (or present at start). Takes precedence
    // Floor-unmet writes a hint and falls through.
    // [Approval park gate, call site 1 of 2] An unresolved approval request
    // written by a previous iteration (or still unresolved at relaunch) parks
    // again instead of re-executing the consequential action.
    const parkedTop = await tryParkOnApprovalRequest(state, { projectDir, runId, runDirPath, iteration });
    if (parkedTop) return { kind: 'settled', state: parkedTop };

    const terminalTop = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration, adapter });
    if (terminalTop.decision === 'matched') return { kind: 'settled', state: terminalTop.state };

    // Archive the shared scheduler/operator ledger between iterations so the
    // planner can read prior guidance without mixing it with current notices.
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
        log.warn({ err, runId, iteration }, 'Failed to archive guidance');
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
      // Only durable round identities survive reset. An otherwise accepted
      // round blocked by another gate is unjournaled and must be measured again.
      const preservedStageIds = consumedResearchStages(state, baseStages, runDirPath);
      for (const s of baseStages) {
        if (preservedStageIds.has(s.id)) continue;
        state.stages[s.id] = rependStageStatus(state.stages[s.id], 0);
        mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
      }
      state.dispatchedStages = undefined;
      state.status = 'running';
      writeRunState(projectDir, runId, state);

      // Clean stale verdict files from previous iteration so new gates start fresh
      try {
        for (const f of readdirSync(runDirPath)) {
          if (f.startsWith('verdict') && f.endsWith('.json')
              && ![...preservedStageIds].some((id) => f === `verdict_${id}.json`)) {
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
      } else if (state.campaignAlert) {
        state.campaignAlert = undefined;
        writeRunState(projectDir, runId, state);
      }
    }
  return {kind: 'ready', state, sorted, injectedDispatchStages, planStageRetries};
}

/** Only a consumed outcome producer and its reviewing gate survive reset.
 * Other fixed stages (including recurring checks and planners) still repeat. */
function consumedResearchStages(state: StoreState, stages: StageConfig[], directory: string): Set<string> {
  const preserved = new Set<string>();
  if (!state.research) return preserved;
  const journalLabels = new Set<string>();
  const consumedDigests = new Set<string>();
  const journalPath = join(directory, 'research_journal.json');
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { rounds: { label: string }[] };
    for (const round of journal.rounds) journalLabels.add(round.label);
  }
  for (const name of readdirSync(directory)) {
    if (/^research_round_\d+_(?:no_candidate_)?consumed\.json$/.test(name)) {
      consumedDigests.add(createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'));
    }
  }
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const result = resolveResearchPaths(state.research).resultFile;
  const complete = (stage: StageConfig): boolean => !stage.dynamic_dispatch
    && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE;
  for (const gate of stages.filter(stage => stage.is_gate && complete(stage))) {
    const candidate = readResearchGateCandidate(directory, gate.id);
    if (!candidate || !((candidate.label && journalLabels.has(candidate.label))
        || (candidate.sha256 && consumedDigests.has(candidate.sha256)))) continue;
    // Stop at preceding gates: their producers represent separate rounds.
    // A downstream recurring gate can capture the same consumed bytes without
    // reviewing a new producer; that alone must not freeze it or other inputs.
    const reviewed = gateReviewedAuthorIds(gate, stages);
    const producers = reviewed.map(id => byId.get(id)!)
      .filter(stage => complete(stage) && !stage.retry_to?.length
        && [result, `${result}.no_candidate.json`].some(path => stageScopeOwnsPath(stage, path)));
    if (producers.length) {
      for (const producer of producers) preserved.add(producer.id);
      // Repeating inputs require a fresh review before downstream work proceeds.
      if (reviewed.every(id => preserved.has(id))) preserved.add(gate.id);
    }
  }
  return preserved;
}
