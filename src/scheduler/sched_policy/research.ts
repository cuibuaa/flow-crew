/** Declaration-owned author → optional review → frozen instrument loop.
 * Project verdicts replace calibration, thresholds, targets and stagnation policy. */
import { atomicWrite } from '../../engine-fs.js';
import { runRecordPath } from '../../run-layout.js';
import { readBriefCriteriaArtifact, extractBriefCriteria } from '../../brief-criteria.js';
import { recordAdmittedPlan } from '../../plan-revisions.js';
import { captureMeasuredCandidate, initializeResearchInstrument, invokeResearchInstrument, researchInstrumentState,
  recordResearchSubmission, finalizeResearchInstrument, restoreResearchBest, researchFrozenStamp, type ResearchInstrumentState } from '../../research-measurement.js';
import { RESEARCH_PROTOCOL } from '../../research-instrument.js';
import { withRunProcessOwnership, runProcessAbortSignal, type Adapter, type AgentConfig } from '../../adapters/base.js';
import { scheduleDeadline, type AttemptDeadlineClock } from '../../attempt-deadline.js';
import { type ResearchConfig, type StoreState, STAGE_STATUS, RUN_STATUS, continuationExhausted, isPausedRunStatus,
  isTerminalRunStatus, isContinuingStage, readRunState, readStageOutput, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { type StageConfig, type WorkflowConfig, parseDispatchedStageConfig } from '../sched_admission/configuration.js';
import { createDispatchAdmission } from '../sched_admission/dispatch.js';
import { executeSingleStage } from '../sched_settlement/stage-execution.js';
import { readGateEvaluation } from '../sched_settlement/gate-verdict.js';
import { readGateVerdictDocument } from '../sched_settlement/gate-evidence.js';
import { runScopeSafeStageGroup, writeCampaignEntry } from '../sched_loop/services.js';
import { parkAtDeploymentBoundary } from '../../deployment-hold.js';
import { concludeRun, projectResearchConclusion } from './run-completion.js';
import { literalProjectScope } from '../sched_admission/scope-services.js';
import { rependContinuingStages } from '../sched_loop/iteration-setup.js';

/** Review criteria are declared identities (P1); the numbered list is stage-readable prose. */
export function researchReviewContract(research: ResearchConfig): string {
  if (!research.review) return '';
  const declared = research.review.criteria.map((text, n) => `  - {id: review-${n + 1}, text: ${JSON.stringify(text)}}`).join('\n');
  return `---\ncriteria:\n${declared}\n---\n# Project candidate review\n\n## Acceptance criteria\n${research.review.criteria.map((c, n) => `${n + 1}. ${c}`).join('\n')}\n`;
}
export function researchStages(research: ResearchConfig): StageConfig[] {
  const contract = { version: 1, produces: [], reads: [] };
  const criteria = extractBriefCriteria(researchReviewContract(research)).criteria.map(c => c.id);
  const author = parseDispatchedStageConfig({ id: 'produce', role: research.author.role, scope: research.candidate.map(literalProjectScope),
    depends_on: [], criterion_refs: criteria, artifact_contract: contract, prompt_template: research.author.instruction });
  return [author, ...(research.review ? [parseDispatchedStageConfig({ id: 'review', role: research.review.role, scope: [], depends_on: [author.id],
    is_gate: true, criterion_refs: criteria, artifact_contract: contract, prompt_template: researchReviewContract(research) })] : [])];
}
export function admitResearchStages(research: ResearchConfig, stages: StageConfig[], projectDir: string, directory: string,
  criteria = research.review ? extractBriefCriteria(researchReviewContract(research)) : undefined) {
  return createDispatchAdmission()({ dispatched: stages, baseStages: [], dispatchStageId: '', research,
    criteria, projectDir, runDir: directory });
}
const save = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
export function researchStopReason(state: ResearchInstrumentState): string | undefined {
  if (state.error) return 'instrument_execution_error';
  if (state.stop) return 'instrument_stop';
  if (state.deadline !== null && Date.now() >= state.deadline) return 'wall_budget_exhausted';
  if (state.history.filter(h => h.phase !== 'initialize' && h.phase !== 'finalize').length >= state.config.budget.max_rounds) return 'round_budget_exhausted';
  return undefined;
}
export async function runResearchLoop(project: string, run: string, directory: string, workflow: WorkflowConfig,
  adapter: Adapter, agents: Map<string, AgentConfig>, agentsDir: string, skills?: string, taskDescription?: string,
  availableSkills?: string, attemptDeadlineClockFactory?: () => AttemptDeadlineClock): Promise<StoreState> {
  let state = readRunState(project, run);
  if (isTerminalRunStatus(state.status)) return state;
  const research = state.research!;
  if (research.protocol !== RESEARCH_PROTOCOL) throw new Error(`Active research requires ${RESEARCH_PROTOCOL}; legacy records are read-only`);
  const stages = workflow.stages;
  const recorded = readBriefCriteriaArtifact(directory);
  const continuing = Boolean(state.queryState?.planRevision && recorded);
  // Keep the admitted declaration snapshot: runtime reads inputs/outputs from it.
  const criteria = continuing ? recorded! : { ...recorded, ...extractBriefCriteria(researchReviewContract(research)) };
  const admission = admitResearchStages(research, stages, project, directory, research.review ? criteria : undefined);
  save(runRecordPath(directory, 'dispatch_admission.json'), admission);
  if (!admission.pass) throw new Error(`Research construction is not dispatchable: ${admission.errors.map(e => e.message).join('; ')}`);
  if (!continuing) save(runRecordPath(directory, 'brief_criteria.json'), criteria);
  recordAdmittedPlan(state, stages, directory, 'Versioned instrument declaration fixes author and optional project review', true, admission);
  state.stages = Object.fromEntries(stages.map(stage => [stage.id, state.stages[stage.id] ?? { status: STAGE_STATUS.PENDING, retries: 0 }]));
  state.maxIterations = Math.max(state.maxIterations ?? 1, research.budget.max_rounds);
  writeRunState(project, run, state);
  const initialized = await initializeResearchInstrument(project, directory, research, state.startedAt);
  const wallExpired = () => initialized.deadline !== null && Date.now() >= initialized.deadline;
  const finish = async (reason: string, status: StoreState['status'] = RUN_STATUS.COMPLETE, detail = reason) => {
    const reasonCode = status === RUN_STATUS.ESCALATED ? 'irreparable_gate_rejection' : status === RUN_STATUS.INCOMPLETE ? 'bounded_attempts' : status === RUN_STATUS.FAILED ? 'stage_failed' : 'workflow_complete';
    const manifest = await finalizeResearchInstrument(directory, reason, { status, reasonCode, detail });
    const conclusion = manifest.conclusion ?? { status, reasonCode, detail };
    state = readRunState(project, run);
    if (!isTerminalRunStatus(state.status)) state = await concludeRun(state, { ...conclusion, writeCampaignEntry });
    projectResearchConclusion(state, () => {});
    return state;
  };
  try {
    if (initialized.termination) return finish(initialized.termination.reason, initialized.termination.conclusion?.status, initialized.termination.conclusion?.detail);
    // Replay settles the best pointer before another author can see the tree.
    if (initialized.history.some(h => h.phase !== 'initialize' && h.phase !== 'finalize' && h.round >= (state.currentIteration ?? 1))) restoreResearchBest(project, directory);
    while (true) {
      const held = parkAtDeploymentBoundary(project, run);
      if (held) return held;
      state = readRunState(project, run);
      if (isTerminalRunStatus(state.status)) return finish(state.reasonCode ?? state.status, state.status);
      if (isPausedRunStatus(state.status)) return state;
      if (Object.values(state.stages).some(isContinuingStage)) {
        if (continuationExhausted(state, state.maxContinuations ?? state.maxIterations! - 1)) return finish('continuation_budget_exhausted', RUN_STATUS.INCOMPLETE);
        rependContinuingStages(state, stages, project, run);
      }
      const measured = researchInstrumentState(directory);
      const stop = researchStopReason(measured);
      if (stop) return finish(stop, measured.error ? RUN_STATUS.FAILED : RUN_STATUS.COMPLETE, measured.error ?? stop);
      const round = measured.history.filter(h => h.phase !== 'initialize' && h.phase !== 'finalize').length + 1;
      if (state.currentIteration !== round) for (const stage of stages) {
        state.stages[stage.id] = rependStageStatus(state.stages[stage.id], 0);
        writeStageStatus(project, run, stage.id, state.stages[stage.id]);
      }
      state.currentIteration = round; writeRunState(project, run, state);
      const execute = async (stage: StageConfig) => {
        // Reuse run cancellation and the shared absolute timer. A hard wall cap
        // replaces reliance on an attempt's soft budget/finishing interval.
        const cap = new AbortController(), parent = runProcessAbortSignal();
        const retireTimer = initialized.deadline === null ? () => {} : scheduleDeadline(() => cap.abort(), () => initialized.deadline! - Date.now());
        try {
          await withRunProcessOwnership(project, run, () => runScopeSafeStageGroup([stage], project, run, round,
            (item, boundary) => executeSingleStage(item, project, run, directory,
              workflow, adapter, agents, agentsDir, readRunState(project, run), stages, skills, taskDescription,
              undefined, undefined, undefined, availableSkills, attemptDeadlineClockFactory, boundary)),
          parent ? AbortSignal.any([parent, cap.signal]) : cap.signal);
        } finally { retireTimer(); }
        state = readRunState(project, run);
        return !wallExpired() && state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE && !isContinuingStage(state.stages[stage.id]);
      };
      const frozenBefore = researchFrozenStamp(directory);
      const authorStage = stages[0];
      if ((state.stages[authorStage.id]?.status !== STAGE_STATUS.COMPLETE || isContinuingStage(state.stages[authorStage.id])) && !await execute(authorStage)) {
        if (isPausedRunStatus(state.status)) return state;
        if (wallExpired()) return finish('wall_budget_exhausted');
        if (isContinuingStage(state.stages[authorStage.id])) continue;
        return finish('author_execution_error', RUN_STATUS.FAILED);
      }
      if (frozenBefore !== researchFrozenStamp(directory)) return finish('frozen_inputs_changed', RUN_STATUS.FAILED);
      const author: unknown = JSON.parse(readStageOutput(project, run, authorStage.id));
      state = readRunState(project, run);
      if (isTerminalRunStatus(state.status)) return finish(state.reasonCode ?? state.status, state.status);
      if (isPausedRunStatus(state.status)) return state;
      const candidate = captureMeasuredCandidate(project, directory, `round-${round}`);
      if (candidate.sha256 === measured.incumbent.sha256) recordResearchSubmission(directory, candidate, round, 'no_candidate', author);
      else {
        const reviewStage = stages[1];
        let review: { pass: boolean; reason?: string; record?: unknown } | undefined;
        let irreparable = false;
        if (reviewStage) {
          if ((state.stages[reviewStage.id]?.status !== STAGE_STATUS.COMPLETE || isContinuingStage(state.stages[reviewStage.id])) && !await execute(reviewStage)) {
            if (isPausedRunStatus(state.status)) return state;
            if (wallExpired()) return finish('wall_budget_exhausted');
            if (isContinuingStage(state.stages[reviewStage.id])) continue;
            return finish('review_execution_error', RUN_STATUS.FAILED);
          }
          if (isTerminalRunStatus(state.status)) return finish(state.reasonCode ?? state.status, state.status);
          if (isPausedRunStatus(state.status)) return state;
          const verdict = readGateEvaluation(project, reviewStage.id, run);
          review = { pass: verdict?.pass === true, reason: verdict?.reason ?? 'Project review unavailable', record: readGateVerdictDocument(directory, reviewStage.id)?.value };
          irreparable = verdict?.repairability?.disposition === 'irreparable';
        }
        if (review?.pass === false) {
          recordResearchSubmission(directory, candidate, round, 'review_rejected', author, review);
          if (irreparable) return finish('irreparable_gate_rejection', RUN_STATUS.ESCALATED, review.reason);
        }
        else await invokeResearchInstrument(directory, 'evaluate', candidate, round, author, review);
      }
      restoreResearchBest(project, directory);
    }
  } catch (error) {
    state = readRunState(project, run);
    if (isTerminalRunStatus(state.status)) {
      return finish(state.reasonCode ?? state.status, state.status);
    }
    return finish('research_execution_error', RUN_STATUS.FAILED, error instanceof Error ? error.message : String(error));
  }
}
