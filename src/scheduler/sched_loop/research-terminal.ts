import { publishRunCompletion } from './iteration-outcome.js';
// Boundary: Settle policy-owned budget exhaustion and rejected research rounds through their admitted terminal owners or precise operator parks.
import { Adapter, AgentConfig } from '../../adapters/base.js';
import { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { ResearchRound } from '../../research-policy.js';
import { recordRunEvent } from '../../run-events.js';
import { generateRunSummary } from '../../run-summary.js';
import { markLeftoverStagesSkipped, recordConfirmNotRun } from '../sched_admission/brief-contract.js';
import { StageConfig, WorkflowConfig } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { appendSchedulerGuidanceOnce } from '../sched_policy/guidance.js';
import { admittedTerminalOwner } from '../sched_policy/terminal-ownership.js';
import { syncStageStatuses } from '../sched_scope/stage-group.js';
import { collectGateRuntimeFacts, structuredFailingGateCriteria } from '../sched_settlement/gate-recovery.js';
import { executeSingleStage } from '../sched_settlement/stage-execution.js';
import { RUN_STATUS, STAGE_STATUS, StoreState, enforceRealityGateBeforeTerminal, isPausedRunStatus, isTerminalRunStatus, readRunState, rependStageStatus, runDir, writeRunState, writeStageStatus } from '../../store.js';
import { executeIteration } from './iteration.js';
import { runScopeSafeStageGroup, tryParkOnApprovalRequest, tryTerminateOnTerminalState, writeCampaignEntry } from './services.js';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createResearchBudgetFinalizer(
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
) {
  const finishResearchCeiling = async (
    state: StoreState,
    iterationNum: number,
    detail: string,
    execution: {
      stages: StageConfig[];
      injectedDispatchStages: Set<string>;
      planStageRetries: Map<string, number>;
    },
  ): Promise<StoreState> => {
    // Banked (journaled) measured rounds — the rounds that survived the integrity gates.
    let bankedRounds = 0;
    try {
      const j = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_journal.json'), 'utf-8'));
      if (j && Array.isArray(j.rounds)) bankedRounds = j.rounds.length;
    } catch { /* no journal → 0 banked */ }
    // Integrity-gate rejections, by reason (e.g. {"noop":3}). Surfaced for observability.
    let rejections: Record<string, number> = {};
    try {
      const r = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_integrity_rejections.json'), 'utf-8'));
      if (r && typeof r === 'object') rejections = r as Record<string, number>;
    } catch { /* no rejections file → none */ }
    const totalRejected = Object.values(rejections).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0);
    // Minimum banked rounds a genuine policy stop_ceiling would require: the policy ceilings at the
    // FIRST of maxRounds reached / haltAfterNoImprovement consecutive measured rounds. Task-agnostic:
    // no domain field/threshold — derived purely from the brief-declared stop conditions.
    const stop = state.research?.stop;
    const ceilingFloors: number[] = [];
    if (typeof stop?.maxRounds === 'number') ceilingFloors.push(stop.maxRounds);
    if (typeof stop?.haltAfterNoImprovement === 'number') ceilingFloors.push(stop.haltAfterNoImprovement);
    // With no stop conditions declared the policy can't render an exhaustive ceiling at all, so a
    // single banked round suffices to call it a (degenerate) ceiling; require >=1 banked round.
    const requiredRounds = ceilingFloors.length > 0 ? Math.min(...ceilingFloors) : 1;
    const insufficientRounds = bankedRounds < requiredRounds;

    let terminalDetail = detail;
    const terminalStatus = insufficientRounds ? RUN_STATUS.INCOMPLETE : RUN_STATUS.CEILING_HIT;
    const terminalFailureReason = insufficientRounds
      ? `${detail} (banked ${bankedRounds}/${requiredRounds} required measured rounds)`
      : undefined;
    if (totalRejected > 0) {
      const summary = Object.entries(rejections).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${k}:${n}`).join(', ');
      terminalDetail = `${detail} | integrity-rejected rounds: ${totalRejected} (${summary})`;
    }
    // FIX D — a budget-exhaustion terminal is always non-ship; record any declared confirm as not-run.
    recordConfirmNotRun(runDir(projectDir, runId), state.research?.confirm, terminalStatus);
    const declaredPathBE = state.terminalStates?.[terminalStatus]?.paths?.[0];
    const admittedOwner = declaredPathBE
      ? admittedTerminalOwner(runDirPath, declaredPathBE)
      : undefined;

    if (admittedOwner && declaredPathBE) {
      // A dynamic research DAG has admitted exactly one terminal owner. Budget
      // exhaustion is still a policy decision, but it must flow through that
      // owner just like an ordinary ship/ceiling decision; otherwise the
      // framework can bypass every mandatory ancestor at the last exit door.
      writeFileSync(join(runDirPath, 'research_decision.json'), `${JSON.stringify({
        version: 1,
        decision: 'stop_ceiling',
        terminalStatus,
        terminalPath: declaredPathBE,
        terminalOwner: admittedOwner,
        reason: terminalDetail,
        budgetExhausted: true,
        bankedRounds,
        requiredRounds,
      }, null, 2)}\n`, 'utf-8');
      mkdirSync(join(runDirPath, 'signals'), { recursive: true });
      const readyPath = join(runDirPath, 'signals', 'research_terminal_ready.json');
      writeFileSync(readyPath, `${JSON.stringify({
        version: 1,
        decision: 'stop_ceiling',
        terminalStatus,
        terminalPath: declaredPathBE,
        terminalOwner: admittedOwner,
        reason: terminalDetail,
      }, null, 2)}\n`, 'utf-8');
      appendSchedulerGuidanceOnce(
        runDirPath,
        admittedOwner,
        `[research-terminal-ready:budget-${iterationNum}]`,
        `The mechanically settled research decision is stop_ceiling because the iteration budget is exhausted. Read research_decision.json and write exactly ${declaredPathBE}; do not write any other terminal path.`,
        Object.keys(state.stages),
      );
      const finalizer = execution.stages.find((stage) => stage.id === admittedOwner);
      if (finalizer) {
        state.stages[admittedOwner] = rependStageStatus(state.stages[admittedOwner], 0);
        writeStageStatus(projectDir, runId, admittedOwner, state.stages[admittedOwner]);
        writeRunState(projectDir, runId, state);
        try { unlinkSync(readyPath); } catch { /* one-shot */ }
        await executeIteration(
          execution.stages, projectDir, runId, runDirPath, workflow, adapter, agents,
          resolvedAgentsDir, roleRegistry, execution.injectedDispatchStages, execution.planStageRetries,
          skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
        );
        const finalized = readRunState(projectDir, runId);
        if (isTerminalRunStatus(finalized.status) || isPausedRunStatus(finalized.status)) return finalized;
        const finalizerStatus = finalized.stages[admittedOwner];
        finalized.status = RUN_STATUS.INCOMPLETE;
        finalized.failureReason = finalizerStatus?.status === STAGE_STATUS.FAILED
          ? `Admitted terminal finalizer ${admittedOwner} failed after the budget-exhaustion decision: ${finalizerStatus.error ?? 'no error detail'}`
          : `Admitted terminal finalizer ${admittedOwner} completed without writing ${declaredPathBE}`;
        finalized.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, finalized);
        writeCampaignEntry(projectDir, finalized);
        return finalized;
      }
      state.status = RUN_STATUS.INCOMPLETE;
      state.failureReason = `Budget exhaustion resolved terminal owner ${admittedOwner}, but that stage was absent from the active admitted DAG.`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      return state;
    }

    state.status = terminalStatus;
    if (terminalFailureReason) state.failureReason = terminalFailureReason;
    state.completedAt = new Date().toISOString();
    // Every budget-exhaustion terminal honors skipped stages and the declared artifact.
    markLeftoverStagesSkipped(state, `research terminal '${state.status}' committed (budget exhausted) before this stage ran`);
    if (declaredPathBE) state.terminalArtifact = declaredPathBE.split('/').pop();
    let reportAbs: string | undefined;
    let declaredAbs: string | undefined;
    let wroteReportCandidate = false;
    let wroteDeclaredCandidate = false;
    try {
      const rc2 = state.research;
      const reportDir = join(projectDir, resolveResearchPaths(rc2).reportDir);
      mkdirSync(reportDir, { recursive: true });
      let roundsMd = '';
      try {
        const j2 = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_journal.json'), 'utf-8')) as { rounds?: ResearchRound[] };
        roundsMd = (j2.rounds ?? []).map((r) => r.outcome === 'no_candidate'
          ? `- ${r.label}: no candidate (${r.reason ?? 'no reason recorded'})`
          : `- ${r.label}: ${r.result}${r.confirmFailed ? ' (confirm gate FAILED — unconfirmed)' : ''}`).join('\n');
      } catch { /* no journal */ }
      const body = `# Research ${state.status === RUN_STATUS.CEILING_HIT ? 'Ceiling' : 'Incomplete'} Report\n\n`
        + `Decision: budget-exhausted ${state.status}\n`
        + `Reason: ${terminalDetail}\n\n`
        + `## Rounds\n${roundsMd}\n`;
      reportAbs = join(reportDir, state.status === RUN_STATUS.CEILING_HIT ? 'program_ceiling_report.md' : 'program_incomplete_report.md');
      if (!existsSync(reportAbs)) {
        writeFileSync(reportAbs, body, 'utf-8');
        wroteReportCandidate = true;
      }
      if (declaredPathBE) {
        declaredAbs = join(projectDir, declaredPathBE);
        if (!existsSync(declaredAbs)) {
          const declaredDir = declaredPathBE.includes('/') ? join(projectDir, declaredPathBE.substring(0, declaredPathBE.lastIndexOf('/'))) : projectDir;
          mkdirSync(declaredDir, { recursive: true });
          writeFileSync(declaredAbs, `> Engine-authored terminal candidate; acceptance remains subject to the declared reality checks.\n\n${body}`, 'utf-8');
          wroteDeclaredCandidate = true;
        }
      }
    } catch { /* non-critical */ }
    // Reality checks now observe the candidate they are expected to verify.
    // A rejected candidate is retained only inside the run directory as audit
    // evidence; it is not allowed to masquerade as committed terminal output.
    const rg = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
    if (!rg.allowed) {
      const quarantine = (source: string | undefined, label: string): void => {
        if (!source || !existsSync(source)) return;
        try { renameSync(source, join(runDirPath, `reality_rejected_${label}`)); } catch { /* preserve evidence in place if move fails */ }
      };
      if (wroteReportCandidate) quarantine(reportAbs, reportAbs?.split('/').pop() ?? 'budget_report');
      if (wroteDeclaredCandidate) quarantine(declaredAbs, declaredPathBE?.split('/').pop() ?? 'terminal_candidate');
      return rg.state;
    }
    publishRunCompletion(state, projectDir, runId, () => ({iteration: iterationNum, detail: terminalDetail}));
    log.info({ runId, iteration: iterationNum, status: state.status, bankedRounds, requiredRounds, totalRejected }, 'Research run: iteration budget exhausted — policy-owned terminal (no gate-pass complete)');
    await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
    return state;
  };;
  return finishResearchCeiling;
}

export async function settleExhaustedResearchGates(
  state: StoreState, sorted: StageConfig[], iteration: number,
  projectDir: string, runId: string, runDirPath: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  skills?: string, taskDescription?: string, availableSkillsList?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock
): Promise<StoreState | undefined> {
    const exhaustedResearchFacts = collectGateRuntimeFacts(sorted, state, projectDir, runId);
    if (state.research && exhaustedResearchFacts.rejectedGateIds.length > 0) {
      let bankedRounds = 0;
      try {
        const journal = JSON.parse(readFileSync(join(runDirPath, 'research_journal.json'), 'utf-8')) as { rounds?: unknown[] };
        bankedRounds = Array.isArray(journal.rounds) ? journal.rounds.length : 0;
      } catch { /* an absent journal means this is round one */ }
      const round = bankedRounds + 1;
      const rejected = new Set(exhaustedResearchFacts.rejectedGateIds);
      const failingGates = sorted.filter((stage) => rejected.has(stage.id));
      const criteria = [...new Set(failingGates.flatMap((stage) => (
        structuredFailingGateCriteria(runDirPath, stage.id)
          ?? (stage.criterion_refs.length > 0 ? stage.criterion_refs : [stage.id])
      )))];
      const reasons = exhaustedResearchFacts.evaluations
        .filter((evaluation) => rejected.has(evaluation.id))
        .map((evaluation) => `${evaluation.id}: ${evaluation.effectiveVerdict?.reason ?? 'gate rejected the round'}`);
      const detail = `Research round ${round} exhausted its gate retries; failing criteria: ${criteria.join(', ')}`
        + (reasons.length > 0 ? ` (${reasons.join('; ')})` : '');
      writeFileSync(join(runDirPath, 'research_gate_exhausted.json'), `${JSON.stringify({
        version: 1,
        round,
        gateIds: exhaustedResearchFacts.rejectedGateIds,
        criteria,
        reasons,
        detectedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf-8');
      recordRunEvent(projectDir, runId, {
        type: 'research_gate_exhausted',
        runId,
        timestamp: new Date().toISOString(),
        iteration,
        round,
        criteria,
        stageIds: exhaustedResearchFacts.rejectedGateIds,
        detail,
        source: 'scheduler',
        level: 'warning',
      });

      const escalationSelection = state.terminalStates?.[RUN_STATUS.ESCALATED]?.paths
        .map((terminalPath) => ({ terminalPath, terminalOwner: admittedTerminalOwner(runDirPath, terminalPath) }))
        .find((selection): selection is { terminalPath: string; terminalOwner: string } => Boolean(selection.terminalOwner));
      if (escalationSelection) {
        writeFileSync(join(runDirPath, 'research_decision.json'), `${JSON.stringify({
          decision: 'escalate',
          runningBest: state.research.baseline,
          keptLabels: [],
          droppedLabels: [],
          consecutiveNoImprovement: 0,
          terminalStatus: RUN_STATUS.ESCALATED,
          terminalPath: escalationSelection.terminalPath,
          terminalOwner: escalationSelection.terminalOwner,
          reason: detail,
          round,
          failingCriteria: criteria,
        }, null, 2)}\n`, 'utf-8');
        mkdirSync(join(runDirPath, 'signals'), { recursive: true });
        writeFileSync(join(runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
          version: 1,
          decision: 'escalate',
          terminalStatus: RUN_STATUS.ESCALATED,
          terminalPath: escalationSelection.terminalPath,
          terminalOwner: escalationSelection.terminalOwner,
          reason: detail,
          round,
          failingCriteria: criteria,
        }, null, 2)}\n`, 'utf-8');
        const finalizer = sorted.find((stage) => stage.id === escalationSelection.terminalOwner);
        if (finalizer && state.stages[finalizer.id]) {
          state.stages[finalizer.id] = rependStageStatus(state.stages[finalizer.id], 0);
          writeStageStatus(projectDir, runId, finalizer.id, state.stages[finalizer.id]);
          writeRunState(projectDir, runId, state);
          appendSchedulerGuidanceOnce(
            runDirPath,
            finalizer.id,
            `[research-gate-exhausted:round-${round}]`,
            `${detail}. Write only the admitted escalation terminal ${escalationSelection.terminalPath}.`,
            Object.keys(state.stages),
          );
          await runScopeSafeStageGroup(
            [finalizer],
            projectDir,
            runId,
            iteration,
            (stage, liveConstraintGuardFactory) => executeSingleStage(
              stage, projectDir, runId, runDirPath, workflow, adapter, agents,
              resolvedAgentsDir, state, sorted, skills, taskDescription,
              undefined, undefined, undefined, availableSkillsList,
              attemptDeadlineClockFactory, liveConstraintGuardFactory,
            ),
          );
          syncStageStatuses(projectDir, runId, [finalizer.id]);
          state = readRunState(projectDir, runId);
          if (isPausedRunStatus(state.status)) return state;
          const terminal = await tryTerminateOnTerminalState(
            state,
            { projectDir, runId, runDirPath, iteration, adapter },
          );
          if (terminal.decision === 'matched') return terminal.state;
        }
        state = readRunState(projectDir, runId);
        state.status = RUN_STATUS.INCOMPLETE;
        state.failureReason = `${detail}; admitted escalation terminal ${escalationSelection.terminalPath} was not produced`;
        state.completedAt = new Date().toISOString();
        markLeftoverStagesSkipped(state, state.failureReason);
        publishRunCompletion(state, projectDir, runId, () => ({iteration: iteration, detail: state.failureReason}));
        return state;
      }

      const requestId = `research-gate-exhausted-i${iteration}-r${round}`;
      const requestPath = join(runDirPath, `approval_request_${requestId}.json`);
      if (!existsSync(requestPath)) {
        writeFileSync(requestPath, `${JSON.stringify({
          id: requestId,
          action: 'resolve_exhausted_research_gate',
          target: `round ${round}: ${criteria.join(', ')}`,
          risk: 'unknown',
          title: detail,
          body: 'No admitted escalation terminal owner exists. Decide whether to revise the evidence/plan or stop the run.',
          requestedAt: new Date().toISOString(),
        }, null, 2)}\n`, 'utf-8');
      }
      const parked = await tryParkOnApprovalRequest(
        state,
        { projectDir, runId, runDirPath, iteration },
      );
      if (parked) return parked;
      throw new Error(`Could not park exhausted research gate for operator review: ${requestId}`);
    }
}
