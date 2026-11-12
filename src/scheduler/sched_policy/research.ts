/** One declaration-owned search loop. Stage execution, isolation and independent
 * verdict validation use the ordinary scheduler primitives. */
import { atomicWrite } from '../../engine-fs.js';
import { runRecordPath } from '../../run-layout.js';
import { readBriefCriteriaArtifact, extractBriefCriteria } from '../../brief-criteria.js';
import { recordAdmittedPlan } from '../../plan-revisions.js';
import { type ProducerNotes, type ResearchRound } from '../../research-history.js';
import { captureMeasuredCandidate, initializeResearchMeasurements, measureResearchCandidate, researchMeasurementState, restoreResearchBest } from '../../research-measurement.js';
import { type Adapter, type AgentConfig } from '../../adapters/base.js';
import { type AttemptDeadlineClock } from '../../attempt-deadline.js';
import { type ResearchConfig, type StoreState, STAGE_STATUS, RUN_STATUS, continuationExhausted, isPausedRunStatus, isTerminalRunStatus, isContinuingStage, readRunState, readStageOutput, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { type StageConfig, type WorkflowConfig, parseDispatchedStageConfig } from '../sched_admission/configuration.js';
import { createDispatchAdmission } from '../sched_admission/dispatch.js';
import { executeSingleStage } from '../sched_settlement/stage-execution.js';
import { readGateEvaluation } from '../sched_settlement/gate-verdict.js';
import { runScopeSafeStageGroup, writeCampaignEntry } from '../sched_loop/services.js';
import { parkAtDeploymentBoundary } from '../../deployment-hold.js';
import { concludeRun } from './run-completion.js';
import { literalProjectScope } from '../sched_admission/scope-services.js';
import { rependContinuingStages } from '../sched_loop/iteration-setup.js';

export const RESEARCH_REVIEW_CONTRACT = `---\ncriteria:\n  - {id: scope, text: 'The candidate respects the brief scope and generality constraints.'}\n  - {id: instrument, text: 'Frozen instrument roots and dependencies are untouched.'}\n  - {id: checks, text: 'All stated checks retain their power.'}\n---\n# Candidate review\n\n## Acceptance criteria\n1. Scope: the candidate respects every stated scope and generality constraint in the brief.\n2. Instrument: frozen instrument roots and their dependencies are untouched.\n3. Checks: all stated checks retain their power; no weakening, bypass or task-specific shortcut.\n\nJudge the submitted candidate's properties using the full brief and the diff. Do not judge measured numbers, improvement, report prose, or missing terminal reports. The engine measures only accepted submissions and writes the terminal report. A rejection settles this submission; it is not an instruction to repair within the same round.\n`;

/** Same construction and admission boundary for launch and rehearsal. */
export function researchStages(research: ResearchConfig): StageConfig[] {
  const refs = extractBriefCriteria(RESEARCH_REVIEW_CONTRACT).criteria.map(c => c.id);
  const contract = { version: 1, produces: [], reads: [] };
  return [
    parseDispatchedStageConfig({ id: 'produce', role: 'coder', scope: research.measurement.candidate.map(literalProjectScope), depends_on: [],
      criterion_refs: refs, artifact_contract: contract,
      prompt_template: 'Propose and implement the next candidate from the brief and engine measurement journal. Build on the current best. Return producer notes with hypothesis, files_changed and property_evidence. Numbers and the terminal report belong to the engine.' }),
    parseDispatchedStageConfig({ id: 'review', role: 'qa', scope: [], depends_on: ['produce'], is_gate: true,
      criterion_refs: refs, artifact_contract: contract, prompt_template: RESEARCH_REVIEW_CONTRACT }),
  ];
}
export function admitResearchStages(research: ResearchConfig, stages: StageConfig[], projectDir: string, directory: string, criteria = extractBriefCriteria(RESEARCH_REVIEW_CONTRACT)) {
  return createDispatchAdmission()({ dispatched: stages, baseStages: [], dispatchStageId: '', research,
    criteria, projectDir, runDir: directory });
}
const save = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');

/** Only task-owned stopping conditions. All non-keeps spend stagnation budget. */
export function researchStopReason(config: ResearchConfig, rounds: ResearchRound[], startedAt: string, best: number, heldOutUses = 0): string | undefined {
  const stop = config.stop;
  if (stop.beat !== undefined && rounds.some(r => r.comparison?.keep) &&
    (config.measurement.metrics[config.measurement.primary[0]].direction === 'min' ? best <= stop.beat : best >= stop.beat)) return 'target_reached';
  if (config.measurement.held_out && heldOutUses >= config.measurement.held_out.allowance) return 'held_out_allowance_exhausted';
  if (stop.maxWallHours !== undefined && Date.now() >= Date.parse(startedAt) + stop.maxWallHours * 3600000) return 'wall_budget_exhausted';
  if (rounds.length >= stop.maxRounds) return 'round_budget_exhausted';
  let streak = 0;
  for (const round of [...rounds].reverse()) { if (round.comparison?.keep) break; streak++; }
  if (stop.haltAfterNoImprovement !== undefined && streak >= stop.haltAfterNoImprovement) return 'no_improvement_budget_exhausted';
  return undefined;
}

export async function runResearchLoop(project: string, run: string, directory: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, agentsDir: string, skills?: string, taskDescription?: string,
  availableSkills?: string, attemptDeadlineClockFactory?: () => AttemptDeadlineClock): Promise<StoreState> {
  let state = readRunState(project, run);
  const research = state.research!;
  if (!research.measurement) throw new Error('Legacy research is retired; declare research.measurement.');
  const stages = workflow.stages;
  const recorded = readBriefCriteriaArtifact(directory);
  const continuing = Boolean(state.queryState?.planRevision && recorded);
  const criteria = continuing ? recorded! : { ...recorded, ...extractBriefCriteria(RESEARCH_REVIEW_CONTRACT) };
  const admission = admitResearchStages(research, stages, project, directory, criteria);
  save(runRecordPath(directory, 'dispatch_admission.json'), admission);
  if (!admission.pass) throw new Error(`Research construction is not dispatchable: ${admission.errors.map(e => e.message).join('; ')}`);
  if (!continuing) save(runRecordPath(directory, 'brief_criteria.json'), criteria);
  recordAdmittedPlan(state, stages, directory, 'Measurement declaration fixes producer and independent property review', true, admission);
  state.stages = Object.fromEntries(stages.map(stage => [stage.id, state.stages[stage.id] ?? { status: STAGE_STATUS.PENDING, retries: 0 }]));
  state.maxIterations = Math.max(state.maxIterations ?? 1, research.stop.maxRounds);
  writeRunState(project, run, state);
  const deadline = research.stop.maxWallHours === undefined ? Infinity : Date.parse(state.startedAt) + research.stop.maxWallHours * 3600000;
  const initial = await initializeResearchMeasurements(project, directory, research.measurement, deadline);
  state = readRunState(project, run);
  if (isTerminalRunStatus(state.status)) return concludeRun(state, { status: state.status,
    reasonCode: state.reasonCode ?? 'scheduler_failed', detail: state.failureReason });
  if (isPausedRunStatus(state.status)) return state;
  if (initial.error) throw new Error(`Research baseline is unmeasured: ${initial.error}`);
  // A committed settlement may precede best-tree restoration at a crash.
  if ((initial.rounds?.length ?? 0) >= (state.currentIteration ?? 1)) restoreResearchBest(project, directory);
  const primary = research.measurement.primary[0];
  const total = () => researchMeasurementState(directory).best.items!.reduce((sum, item) => sum + item.metrics[primary], 0);
  const finish = async (reason: string) => {
    state = readRunState(project, run);
    const ship = reason === 'target_reached';
    save(runRecordPath(directory, 'research_decision.json'), { decision: ship ? 'ship' : 'stop_ceiling', reason, runningBest: total(),
      keptLabels: (researchMeasurementState(directory).rounds ?? []).filter(round => round.comparison?.keep).map(round => round.label) });
    return await concludeRun(state, { status: ship ? RUN_STATUS.SHIPPED : RUN_STATUS.CEILING_HIT,
      reasonCode: ship ? 'research_shipped' : 'research_ceiling', detail: reason, writeCampaignEntry });
  };
  while (true) {
    const held = parkAtDeploymentBoundary(project, run);
    if (held) return held;
    state = readRunState(project, run);
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
    if (Object.values(state.stages).some(isContinuingStage)) {
      if (continuationExhausted(state, state.maxContinuations ?? state.maxIterations! - 1)) return concludeRun(state, {
        status: RUN_STATUS.INCOMPLETE, reasonCode: 'bounded_attempts',
        detail: 'Retained research stage work needs continuation, but its finite continuation budget is exhausted; no candidate measured', writeCampaignEntry });
      rependContinuingStages(state, stages, project, run);
    }
    let measured = researchMeasurementState(directory);
    const rounds = measured.rounds ?? [];
    const stop = researchStopReason(research, rounds, state.startedAt, total(), measured.heldOutUses.length);
    const round = rounds.length + 1;
    const settling = state.currentIteration === round && stages.every(stage => state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE && !isContinuingStage(state.stages[stage.id]));
    if (stop && !settling) return finish(stop);
    if (state.currentIteration !== round) {
      for (const stage of stages) {
        state.stages[stage.id] = rependStageStatus(state.stages[stage.id], 0);
        writeStageStatus(project, run, stage.id, state.stages[stage.id]);
      }
    }
    state.currentIteration = round;
    writeRunState(project, run, state);
    const execute = async (stage: StageConfig) => {
      await runScopeSafeStageGroup([stage], project, run, round, (item, boundary) => executeSingleStage(item, project, run, directory,
        workflow, adapter, agents, agentsDir, readRunState(project, run), stages, skills, taskDescription,
        undefined, undefined, undefined, availableSkills, attemptDeadlineClockFactory, boundary));
      state = readRunState(project, run);
      return state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE && !isContinuingStage(state.stages[stage.id]);
    };
    if ((state.stages[stages[0].id]?.status !== STAGE_STATUS.COMPLETE || isContinuingStage(state.stages[stages[0].id])) && !await execute(stages[0])) {
      if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
      if (isContinuingStage(state.stages[stages[0].id])) continue;
      restoreResearchBest(project, directory);
      return concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'stage_failed', detail: 'Research producer did not complete; no candidate measured', writeCampaignEntry });
    }
    // The producer's structured result is advisory prose only.
    const produced = JSON.parse(readStageOutput(project, run, stages[0].id)) as { notes?: ProducerNotes };
    const notes = produced?.notes;
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
    const candidate = captureMeasuredCandidate(project, directory, `round-${round}`);
    if (candidate.error) throw new Error(`Candidate capture failed: ${candidate.error}`);
    const entry: ResearchRound = { label: `round-${round}`, candidate: candidate.sha256, notes, wallHoursCumulative: (Date.now() - Date.parse(state.startedAt)) / 3600000 };
    if (candidate.sha256 === measured.best.candidate) {
      Object.assign(entry, { outcome: 'no_candidate', reason: 'Candidate content equals the current best' });
    } else {
      if ((state.stages[stages[1].id]?.status !== STAGE_STATUS.COMPLETE || isContinuingStage(state.stages[stages[1].id])) && !await execute(stages[1])) {
        if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
        if (isContinuingStage(state.stages[stages[1].id])) continue;
        restoreResearchBest(project, directory);
        return concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'stage_failed', detail: 'Candidate review failed to execute; no measurement', writeCampaignEntry });
      }
      if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
      const review = readGateEvaluation(project, stages[1].id, run);
      entry.review = { pass: review?.pass === true, reason: review?.reason ?? 'Independent review unavailable' };
      if (!entry.review.pass) Object.assign(entry, { outcome: 'review_rejected', reason: entry.review.reason });
      else {
        const result = await measureResearchCandidate(directory, candidate, deadline - Date.now(), entry);
        Object.assign(entry, { outcome: result.observation.status, measurement: result.observation,
          comparison: result.comparison, guards: result.guards, reason: result.comparison.reason,
          ...(result.observation.items ? { result: result.observation.items.reduce((sum, item) => sum + item.metrics[primary], 0) } : {}) });
      }
    }
    measured = researchMeasurementState(directory);
    if (!entry.comparison) {
      measured.rounds = [...rounds, entry];
      save(runRecordPath(directory, 'research_measurement/state.json'), measured);
    }
    restoreResearchBest(project, directory);
    state = readRunState(project, run);
    if (isTerminalRunStatus(state.status)) return concludeRun(state, { status: state.status,
      reasonCode: state.reasonCode ?? 'scheduler_failed', detail: state.failureReason });
    if (isPausedRunStatus(state.status)) return state;
    if (entry.review?.pass === false && readGateEvaluation(project, stages[1].id, run)?.repairability?.disposition === 'irreparable') return concludeRun(state, { status: RUN_STATUS.ESCALATED, reasonCode: 'irreparable_gate_rejection', detail: entry.reason, writeCampaignEntry });
    const settledStop = researchStopReason(research, measured.rounds ?? [], state.startedAt, total(), measured.heldOutUses.length);
    if (settledStop) return finish(settledStop);
  }
}
