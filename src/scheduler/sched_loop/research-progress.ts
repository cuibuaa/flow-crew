// Boundary: Publish iteration accounting, advance only fully settled research evidence, and dispatch admitted policy finalizers before deciding to continue.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { recordRunEvent } from '../../run-events.js';
import { generateRunSummary } from '../../run-summary.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { clearGateContinuationsForStages } from '../sched_admission/sessions.js';
import { log } from '../sched_admission/shared.js';
import { observeStableBlockage } from '../sched_policy/guidance.js';
import { anyFailed } from '../sched_scope/stage-group.js';
import { collectGateRuntimeFacts, recoverVerifiedResearchSettlement, researchAdvanceEligible } from '../sched_settlement/gate-recovery.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, isPausedRunStatus, isRunningStageStatus, isTerminalRunStatus, readRunState, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { IterationDisposition } from './iteration-outcome.js';
import { executeIteration } from './iteration.js';
import { appendIterationLog, concludeRepeatedBlockage, tryAdvanceResearch, writeCampaignEntry } from './services.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export async function advanceSettledResearch(
  state: StoreState, sorted: StageConfig[], baseStages: StageConfig[], iteration: number,
  iterationDispatchedIds: string[], innerRetriesUsed: number, maxInnerRetries: number,
  maxIterations: number, injectedDispatchStages: Set<string>, planStageRetries: Map<string, number>,
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
): Promise<IterationDisposition> {
    // Settle retry stages still marked running after gate retries.
    for (const s of sorted) {
      if (s.retry_to && s.retry_to.length > 0 && state.stages[s.id] && isRunningStageStatus(state.stages[s.id].status)) {
        state.stages[s.id] = { ...state.stages[s.id], status: STAGE_STATUS.SKIPPED };
        writeRunState(projectDir, runId, state);
      }
    }

    // Append iteration log
    appendIterationLog(projectDir, runId, iteration, state, iterationDispatchedIds, baseStages.map(s => s.id), innerRetriesUsed, maxInnerRetries);
    writeCampaignEntry(projectDir, state);

    recordRunEvent(projectDir, runId, {
      type: 'iteration_completed',
      runId,
      timestamp: new Date().toISOString(),
      iteration,
      detail: `iteration ${iteration} completed`,
    });

    // A research result is not durable campaign evidence until every gate has
    // settled green. This is
    // the sole research-advance call site: an eager pre-gate consumer could
    // previously bank a rejected round and move the campaign to the next one.
    state = readRunState(projectDir, runId);
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };
    const settledResearchGates = collectGateRuntimeFacts(sorted, state, projectDir, runId);
    if (state.research && researchAdvanceEligible({
      gatesSettled: settledResearchGates.allPass,
      stageFailed: anyFailed(state),
      supervisorRejectPending: false,
    })) {
      const recoveredSettlement = recoverVerifiedResearchSettlement(sorted, state, projectDir, runId, runDirPath);
      const researchResult = recoveredSettlement
        ? null
        : await tryAdvanceResearch(state, { projectDir, runId, runDirPath, iteration, adapter });
      if (researchResult) return { kind: 'settled', state: researchResult };
      state = readRunState(projectDir, runId);
      const repeatedAfterResearch = concludeRepeatedBlockage(
        state,
        { projectDir, runId, runDirPath, iteration },
      );
      if (repeatedAfterResearch) {
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return { kind: 'settled', state: repeatedAfterResearch };
      }
      const terminalReadyPath = join(runDirPath, 'signals', 'research_terminal_ready.json');
      if (existsSync(terminalReadyPath)) {
        let terminalOwner: string | undefined;
        try {
          const signal = JSON.parse(readFileSync(terminalReadyPath, 'utf-8')) as Record<string, unknown>;
          if (typeof signal.terminalOwner === 'string') terminalOwner = signal.terminalOwner;
        } catch { /* handled as an unresolved owner below */ }
        const finalizer = terminalOwner ? sorted.find((stage) => stage.id === terminalOwner) : undefined;
        if (!finalizer) {
          state.status = RUN_STATUS.INCOMPLETE;
          state.failureReason = 'Research policy reached a terminal decision, but its admitted terminal owner could not be resolved.';
          state.completedAt = new Date().toISOString();
          writeRunState(projectDir, runId, state);
          return { kind: 'settled', state };
        }
        state.stages[finalizer.id] = rependStageStatus(state.stages[finalizer.id], 0);
        writeStageStatus(projectDir, runId, finalizer.id, state.stages[finalizer.id]);
        writeRunState(projectDir, runId, state);
        try { unlinkSync(terminalReadyPath); } catch { /* one-shot */ }
        const finalized = await executeIteration(
          sorted, projectDir, runId, runDirPath, workflow, adapter, agents,
          resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries, skills, taskDescription,
          availableSkillsList, attemptDeadlineClockFactory,
        );
        state = readRunState(projectDir, runId);
        if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return { kind: 'settled', state };
        if (finalized.stages[finalizer.id]?.status === STAGE_STATUS.FAILED) {
          observeStableBlockage({
            runDirPath,
            kind: 'terminal_finalizer',
            stageId: finalizer.id,
            detail: finalized.stages[finalizer.id]?.error ?? 'terminal finalizer failed',
            evidenceDigest: (() => {
              const path = join(runDirPath, 'stages', finalizer.id, 'output.md');
              try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return undefined; }
            })(),
            threshold: state.campaignTriggers?.repeatedFailureAfter,
          });
          const repeatedFinalizer = concludeRepeatedBlockage(
            state,
            { projectDir, runId, runDirPath, iteration },
          );
          if (repeatedFinalizer) {
            await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
            return { kind: 'settled', state: repeatedFinalizer };
          }
        }
      }
      const contSignal = join(runDirPath, 'signals', 'research_continue.json');
      if (existsSync(contSignal) && iteration < maxIterations) {
        try { unlinkSync(contSignal); } catch { /* non-critical */ }
        clearGateContinuationsForStages(runDirPath, sorted);
        log.info({ runId, iteration }, 'Settled gates accepted the research round; re-planning the next round');
        return { kind: 'next-iteration', state };
      }
    }
  return {kind: 'continue', state};
}
