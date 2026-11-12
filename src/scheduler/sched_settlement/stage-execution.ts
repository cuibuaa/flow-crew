import { stageDurationLimit } from '../../stage-duration.js';
import { classifyEnding } from '../../attempt-ending.js';
import { runRecordPath } from '../../run-layout.js';
import { concludeRun } from '../sched_policy/run-completion.js';
import { appendGateEvidenceInstruction } from './gate-archives.js';
// Boundary: Technical attempt budgets and one repair/re-evaluation stage execution; uses existing worker and typed prompt/session/validation boundaries.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { loadAdapterByName } from '../../adapters/loader.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState, createTechnicalRetryBudgetState, transitionTechnicalRetryBudget } from '../../attempt-deadline.js';
import { RUN_STATUS, STAGE_STATUS, StageAttemptSettlementError, StageStatus, StoreState, isPendingStageStatus, isRunningStageStatus, readRunState, readStageStatus, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { freshRunningStageProjection, runStage } from '../../worker.js';
import { stageRecordSchema } from '../../handoff.js';
import { StageConfig, WorkflowConfig, configuredTechnicalRetryLimit, failureRetryLimit, parseAgent } from '../sched_admission/configuration.js';
import { buildRetryPreamble } from '../sched_admission/dispatch-retry.js';
import { applyBasePrompt, buildRoleRegistry, loadBasePrompt } from '../sched_admission/dispatch.js';
import { log } from '../sched_admission/shared.js';
import { appendAttemptDeadlineContract, appendGateConstraintAuditContext, appendPlannerAdmissionContract, appendResearchPathContract, appendProjectWriteContext } from '../sched_policy/prompt-contracts.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendUnresolvedStageObligationContext } from './completion.js';
import { buildGateFixCorrectionContract, gateArchiveCoordinate } from './gate-archives.js';
import { isGateReviewed, gateReviewedAuthorIds } from './gate-recovery.js';

export function createSchedulerTechnicalRetryState(
  initialBudgetMs: number,
  priorStatus?: StageStatus,
  recover = false,
): TechnicalRetryBudgetState {
  const retryRecovery = recover && (
    isPendingStageStatus(priorStatus?.status ?? '')
    || isRunningStageStatus(priorStatus?.status ?? '')
  );
  const retries = retryRecovery ? Math.max(0, priorStatus?.retries ?? 0) : 0;
  const priorAttempt = retries > 0 ? priorStatus?.attempts?.at(-1) : undefined;
  const priorTimeout = priorAttempt?.timeout;
  const persistedBudget = priorTimeout?.budgetMs;
  const previousBudgetMs = Number.isSafeInteger(persistedBudget) && Number(persistedBudget) > 0
    ? Number(persistedBudget)
    : initialBudgetMs;
  const priorTimedOut = priorAttempt?.terminationCause === 'attempt_timeout';
  return createTechnicalRetryBudgetState({
    initialBudgetMs,
    previousEffectiveBudgetMs: retries > 0 ? previousBudgetMs : undefined,
    timedOut: priorTimedOut,
    attemptsStarted: retries,
  });
}

export function prepareSchedulerTechnicalAttempt(chain: TechnicalRetryBudgetState): {
  budgetMs: number;
  retryContext?: { previousBudgetMs: number; nextBudgetMs: number };
} {
  const transition = transitionTechnicalRetryBudget(chain, { type: 'prepare_attempt' });
  if (transition.type !== 'attempt_prepared') throw new Error('technical retry state did not prepare an attempt');
  return { budgetMs: transition.budgetMs, retryContext: transition.retryContext };
}

export function recordSchedulerTechnicalAttemptResult(
  chain: TechnicalRetryBudgetState,
  result: Pick<RunResult, 'effectiveTimeoutMs' | 'terminationCause'>,
  preparedBudgetMs: number,
): void {
  const effectiveBudgetMs = result.effectiveTimeoutMs ?? preparedBudgetMs;
  const retryableTimeout = result.terminationCause === 'attempt_timeout';
  transitionTechnicalRetryBudget(chain, retryableTimeout
    ? { type: 'attempt_timed_out', effectiveBudgetMs }
    : { type: 'attempt_finished', effectiveBudgetMs });
}

/** Both scheduling paths consume the worker's ending; historical fixture/results
 * without one use only their structured exit/control facts. */
export function decideStageRetry(
  result: Pick<RunResult, 'exitCode' | 'terminationCause' | 'endingCause' | 'engineVoid' | 'providerFailure'>,
  retries: number, technicalLimit: number, failureLimit: number,
): 'engine_void' | 'retry' | 'stop' {
  const cause = result.endingCause ?? classifyEnding({ ...result, engineVoid: result.engineVoid || result.terminationCause === 'engine_void', cancelled: ['stage_abort', 'cancelled', 'host_restart'].includes(result.terminationCause ?? '') });
  if (cause === 'engine_void') return 'engine_void';
  if (!['work_failed', 'process_death'].includes(cause)) return 'stop';
  if (result.providerFailure?.kind === 'authentication' || result.providerFailure?.kind === 'input_too_large' || result.providerFailure?.kind === 'duration_limit') return 'stop';
  const limit = cause === 'process_death' || result.providerFailure?.kind === 'transient' || result.terminationCause === 'attempt_timeout' ? technicalLimit : failureLimit;
  return retries < limit ? 'retry' : 'stop';
}

/** Process crashes use the existing immutable attempt history, not work retries.
 * A completed stage execution starts a new chain; reboot records never charge it. */
export function stageRetryCharge(status: StageStatus, result: RunResult, retries: number): number {
  if (result.endingCause !== 'process_death') return retries;
  const attempts = status.attempts ?? [];
  let deaths = 0;
  for (let index = attempts.length - 1; index >= 0 && attempts[index].status !== STAGE_STATUS.COMPLETE; index--)
    deaths += Number(attempts[index].endingCause === 'process_death');
  return Math.max(0, deaths - 1);
}

/** Quota is a resource wait using the existing parked-run recovery channel. */
export function parkProviderQuota(state: StoreState, project: string, run: string, stage: string, result: RunResult): boolean {
  if (result.endingCause !== 'provider_quota' || !result.providerFailure?.resetAt) return false;
  const previous = readStageStatus(project, run, stage);
  state.stages[stage] = rependStageStatus(previous, previous.retries, previous.error);
  writeStageStatus(project, run, stage, state.stages[stage]);
  state.status = RUN_STATUS.PARKED;
  state.recovery = { cause: 'provider_quota', kind: 'resumable', notBefore: result.providerFailure.resetAt,
    reason: `Provider quota exhausted; resume after ${result.providerFailure.resetAt}.`, at: new Date().toISOString(), interruptedStages: [stage] };
  writeRunState(project, run, state);
  return true;
}

export async function executeSingleStage(
  stage: StageConfig,
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  state: StoreState,
  allStages: StageConfig[],
  skills?: string,
  taskDescription?: string,
  innerRetry?: number,
  fixStageIds?: string[],
  roundDiffPath?: string,
  availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
  settlementBoundary?: (phase: 'attempt_closed') => Promise<void>,
): Promise<RunResult | undefined> {
  if (!agents.has(stage.role)) {
    const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
    const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
    agents.set(stage.role, applyBasePrompt(parseAgent(raw), loadBasePrompt(resolvedAgentsDir)));
  }
  const agent = agents.get(stage.role)!;
  const initialTimeout = stageDurationLimit(state.stageDurationLimitMs);
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  let resolvedPrompt = stage.prompt_template || '';
  if (!stage.is_gate && stage.retry_to?.length && innerRetry !== undefined) {
    resolvedPrompt = `${buildGateFixCorrectionContract(runDirPath, stage.retry_to,
      gateArchiveCoordinate(state.currentIteration ?? 1, innerRetry + 1))}\n\n${resolvedPrompt}`;
  }

  resolvedPrompt = appendStageExecutionContracts(resolvedPrompt, stage, allStages, state, projectDir, runId, runDirPath);

  if (stage.is_gate) {
    resolvedPrompt = appendGateEvidenceInstruction(resolvedPrompt, runDirPath, stage.id, state.currentIteration ?? 1, innerRetry);
  }

  let availableRoles: string | undefined;
  if (stage.dynamic_dispatch) {
    availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }

  const maxTechnicalRetries = configuredTechnicalRetryLimit();
  const maxFailureRetries = failureRetryLimit(stage, workflow);

  const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
  let result: RunResult | undefined;
  const technicalRetry = createSchedulerTechnicalRetryState(initialTimeout, state.stages[stage.id], true);

  while (true) {
    // A prior technical attempt is completed by runStage() directly in the
    // per-stage status file. Re-read that authoritative ledger before marking
    // the next attempt running; the scheduler's in-memory state predates the
    // call and must never overwrite a just-recorded timeout/failure.
    let latestStageStatus = state.stages[stage.id];
    try { latestStageStatus = readStageStatus(projectDir, runId, stage.id); } catch { /* first execution */ }
    const retries = state.stages[stage.id]?.retries ?? 0;
    const prepared = prepareSchedulerTechnicalAttempt(technicalRetry);
    const researchWall = state.research?.budget?.wall_seconds;
    if (researchWall !== undefined) prepared.budgetMs = Math.max(1, Math.min(prepared.budgetMs,
      Math.floor(Date.parse(state.startedAt) + researchWall * 1000 - Date.now())));
    // Read the failure cause before the running projection clears latest error.
    const retryPreamble = retries > 0
      ? buildRetryPreamble(retries, prepared.budgetMs, runDirPath, stage.id, prepared.retryContext)
      : undefined;
    state.stages[stage.id] = freshRunningStageProjection(latestStageStatus, retries);
    writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
    writeRunState(projectDir, runId, state);

    result = await runStage(stageAdapter, {
      stageId: stage.id,
      role: agent,
      attribution: { role: stage.role, iteration: state.currentIteration ?? 1 },
      dependsOn: stage.depends_on ?? [],
      promptTemplate: appendAttemptDeadlineContract(retryPreamble
        ? `${retryPreamble}\n\n${resolvedPrompt}`
        : resolvedPrompt, prepared.budgetMs),
      artifactObligationTemplate: stage.prompt_template,
      artifactContract: stage.artifact_contract,
      outputSchema: stageRecordSchema({ isGate: stage.is_gate,
        criterionRefs: stage.criterion_refs, extendedVerdict: !state.research && Boolean(stage.artifact_contract?.produces.some(output => output.path === `work/verdict_${stage.id}.json`) || state.campaignStorageKey || state.research || existsSync(runRecordPath(runDirPath, 'gate_contract.json')) || existsSync(runRecordPath(runDirPath, 'supervisor_guidance.md'))) }),
      planRevision: state.queryState?.planRevision,
      artifactStatuses: state.stages,
      timeout_ms: prepared.budgetMs,
      ...(attemptDeadlineClockFactory ? { deadlineClock: attemptDeadlineClockFactory() } : {}),
      projectDir,
      runId,
      runDir: runDirPath,
      retries,
      skills,
      stageSkills: stage.skills,
      availableRoles,
      availableSkills,
      taskDescription: taskDescription || state.taskDescription,
      isGate: stage.is_gate,
      gateContext: { authorIds: gateReviewedAuthorIds(stage, allStages), fixStageIds, roundDiffPath },
      gateReviewed: isGateReviewed(stage, allStages),
      dynamicDispatch: stage.dynamic_dispatch,
      criterionRefs: stage.criterion_refs,
      settlementBoundary,
    });

    if (parkProviderQuota(state, projectDir, runId, stage.id, result)) return;
    recordSchedulerTechnicalAttemptResult(technicalRetry, result, prepared.budgetMs);
    const decision = decideStageRetry(result, stageRetryCharge(readStageStatus(projectDir, runId, stage.id), result, retries), maxTechnicalRetries, maxFailureRetries);
    if (decision === 'engine_void') {
      throw new StageAttemptSettlementError(stage.id, readStageStatus(projectDir, runId, stage.id).attempts!.at(-1)!.index, new Error(result.friendlyError));
    }
    state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
    if (decision === 'retry' && (researchWall === undefined || Date.now() - Date.parse(state.startedAt) < researchWall * 1000)) {
      state.stages[stage.id] = rependStageStatus(state.stages[stage.id], retries + Number(result.endingCause !== 'process_death'), state.stages[stage.id].error);
      writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
      writeRunState(projectDir, runId, state);
      log.warn({ stage: stage.id, retry: retries + 1, decision }, 'Retrying stage (inner loop)');
      continue;
    }
    if (result.providerFailure && result.providerFailure.kind !== 'refusal') {
      const detail = `Upstream adapter failure exhausted technical recovery for ${stage.id}: ${result.providerFailure?.kind}`;
      concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: result.providerFailure.kind === 'input_too_large' ? 'input_too_large' : 'adapter_failure', detail, pendingStageNote: detail, eventFields: () => ({
        iteration: state.currentIteration ?? 1, stageId: stage.id, detail, source: 'scheduler', level: 'warning',
      }) });
      return result;
    }
    if (result.terminationCause === 'attempt_timeout') transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });

    break;
  }

  return result;
}


/** Prompt-only enrichment shared by ordinary execution and gate repair. */
export function appendStageExecutionContracts(
  resolvedPrompt: string, stage: StageConfig, allStages: StageConfig[],
  state: Pick<StoreState, 'research' | 'terminalStates' | 'workflowName'>,
  projectDir: string, runId: string, runDirPath: string,
): string {
  resolvedPrompt = appendProjectWriteContext(resolvedPrompt, stage);
  resolvedPrompt = appendResearchPathContract(resolvedPrompt, state.research, state.terminalStates, runDirPath);
  if (stage.dynamic_dispatch) {
    resolvedPrompt = appendPlannerAdmissionContract(resolvedPrompt, state.terminalStates);
    resolvedPrompt = appendUnresolvedStageObligationContext(resolvedPrompt, readRunState(projectDir, runId));
  }

  const current = readRunState(projectDir, runId);
  resolvedPrompt = appendGateConstraintAuditContext(resolvedPrompt, stage, allStages, current, runDirPath);

  return resolvedPrompt;
}
