import { concludeRun } from '../sched_policy/run-completion.js';
import { appendGateEvidenceInstruction } from './gate-archives.js';
// Boundary: Technical attempt budgets and one repair/re-evaluation stage execution; uses existing worker and typed prompt/session/validation boundaries.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { loadAdapterByName } from '../../adapters/loader.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState, createTechnicalRetryBudgetState, nextTechnicalRetryBudget, transitionTechnicalRetryBudget } from '../../attempt-deadline.js';
import { isSessionReuseEnabled } from '../../config.js';
import { RUN_STATUS, StageAttemptSettlementError, StageStatus, StoreState, isPendingStageStatus, isRunningStageStatus, readRunState, readStageStatus, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { freshRunningStageProjection, runStage } from '../../worker.js';
import { stageRecordSchema } from '../../handoff.js';
import { StageConfig, WorkflowConfig, configuredTechnicalRetryLimit, failureRetryLimit, loadDefaults, parseAgent } from '../sched_admission/configuration.js';
import { buildRetryPreamble } from '../sched_admission/dispatch-retry.js';
import { applyBasePrompt, buildRoleRegistry, loadBasePrompt } from '../sched_admission/dispatch.js';
import { gateContinuationSessionForStage, sessionResumeForStage, shouldPreserveSession } from '../sched_admission/sessions.js';
import { log } from '../sched_admission/shared.js';
import { appendApprovalRequestContract, appendAttemptDeadlineContract, appendGateConstraintAuditContext, appendPlannerAdmissionContract, appendResearchPathContract, appendProjectWriteContext } from '../sched_policy/prompt-contracts.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendUnresolvedStageObligationContext } from './completion.js';
import { gateArchiveArtifactPath, buildGateFixCorrectionContract, gateArchiveCoordinate } from './gate-archives.js';
import { isGateReviewed, isResearchOutcomeGate } from './gate-recovery.js';

export function stageInitialTimeout(): number {
  return loadDefaults().default_timeout_ms;
}

export function budgetAfterTimeouts(initialBudgetMs: number, timeoutCount: number): number {
  let budget = initialBudgetMs;
  for (let index = 0; index < timeoutCount; index++) budget = nextTechnicalRetryBudget(budget);
  return budget;
}

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
    : budgetAfterTimeouts(initialBudgetMs, Math.max(0, retries - 1));
  const priorTimedOut = priorAttempt?.terminationCause === 'attempt_timeout';
  return createTechnicalRetryBudgetState({
    initialBudgetMs,
    currentBudgetMs: retries > 0 ? previousBudgetMs : initialBudgetMs,
    previousEffectiveBudgetMs: retries > 0 ? previousBudgetMs : undefined,
    increaseAfterTimeout: priorTimedOut,
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

/** Both scheduling paths spend the same persisted retry count, regardless of failure class. */
export function decideStageRetry(
  result: Pick<RunResult, 'exitCode' | 'terminationCause' | 'engineVoid' | 'providerFailure'>,
  retries: number, technicalLimit: number, failureLimit: number,
): 'engine_void' | 'retry' | 'stop' {
  if (result.engineVoid || result.terminationCause === 'engine_void') return 'engine_void';
  if (result.exitCode === 0 || ['stage_abort', 'cancelled', 'host_restart'].includes(result.terminationCause ?? '')) return 'stop';
  if (result.providerFailure?.kind === 'authentication') return 'stop';
  const limit = result.providerFailure?.kind === 'transient' || result.terminationCause === 'attempt_timeout' ? technicalLimit : failureLimit;
  return retries < limit ? 'retry' : 'stop';
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
  const initialTimeout = stageInitialTimeout();
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  let resolvedPrompt = stage.prompt_template || '';
  if (!resolvedPrompt) resolvedPrompt = taskDescription ?? '';

  // Inject inner retry context so the agent knows this is a repeated attempt
  if (innerRetry !== undefined) {
    const archiveCoordinate = gateArchiveCoordinate(state.currentIteration ?? 1, innerRetry + 1);
    const activeRetryGateIds = (stage.retry_to ?? []).filter((gateId) =>
      existsSync(gateArchiveArtifactPath(runDirPath, archiveCoordinate, gateId, 'output')),
    );
    if (!stage.is_gate && innerRetry > 0) {
      // Build references to the gate verdicts and outputs that triggered this retry
      const gateRefs = activeRetryGateIds.map(gid =>
        `- Verdict: ${gateArchiveArtifactPath(runDirPath, archiveCoordinate, gid, 'verdict')}\n- QA output: ${gateArchiveArtifactPath(runDirPath, archiveCoordinate, gid, 'output')}`
      ).join('\n');
      const gateContext = gateRefs ? `\nRead the latest gate results first:\n${gateRefs}\n` : '';
      resolvedPrompt = `RETRY FIX (attempt ${innerRetry + 1}): Previous fix attempt did not resolve all issues.${gateContext}\nRead your previous output at ${runDirPath}/stages/${stage.id}/output_attempt_${innerRetry}.md (falling back to output.md if that file is absent, which is the case for runs recorded before attempt-scoped outputs existed) to see what you already tried. Try a DIFFERENT approach — do not repeat the same fix.\n\n${resolvedPrompt}`;
    }
    if (!stage.is_gate && activeRetryGateIds.length) {
      resolvedPrompt = `${buildGateFixCorrectionContract(runDirPath, activeRetryGateIds, archiveCoordinate)}\n\n${resolvedPrompt}`;
    }
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

  const sessionReuseEnabled = isSessionReuseEnabled();
  const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
  const gateSession = gateContinuationSessionForStage(stage, runDirPath, innerRetry !== undefined, stageAdapter.sessionKind);
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
    // Read the failure cause before the running projection clears latest error.
    const retryPreamble = retries > 0
      ? buildRetryPreamble(retries, prepared.budgetMs, runDirPath, stage.id, prepared.retryContext)
      : undefined;
    state.stages[stage.id] = freshRunningStageProjection(latestStageStatus, retries);
    writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
    writeRunState(projectDir, runId, state);

    const resumeSession = gateSession ?? sessionResumeForStage(stage, allStages, state, runDirPath, sessionReuseEnabled, stageAdapter.sessionKind);
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
        criterionRefs: stage.criterion_refs, extendedVerdict: Boolean(stage.artifact_contract?.produces.some(output => output.path === `verdict_${stage.id}.json`) || state.campaignStorageKey || state.research || existsSync(join(runDirPath, 'gate_contract.json')) || existsSync(join(runDirPath, 'supervisor_guidance.md'))) }),
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
      gateContext: { fixStageIds, roundDiffPath },
      gateReviewed: isGateReviewed(stage, allStages),
      dynamicDispatch: stage.dynamic_dispatch,
      researchOutcomeGate: isResearchOutcomeGate(stage, allStages, state.research),
      criterionRefs: stage.criterion_refs,
      resumeSessionId: resumeSession?.sessionId,
      sessionOwnerStageId: resumeSession?.ownerStageId,
      preserveSession: shouldPreserveSession(stage, allStages, sessionReuseEnabled),
      settlementBoundary,
    });

    recordSchedulerTechnicalAttemptResult(technicalRetry, result, prepared.budgetMs);
    const decision = decideStageRetry(result, retries, maxTechnicalRetries, maxFailureRetries);
    if (decision === 'engine_void') {
      throw new StageAttemptSettlementError(stage.id, readStageStatus(projectDir, runId, stage.id).attempts!.at(-1)!.index, new Error(result.friendlyError));
    }
    state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
    if (decision === 'retry') {
      state.stages[stage.id] = rependStageStatus(state.stages[stage.id], retries + 1, state.stages[stage.id].error);
      writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
      writeRunState(projectDir, runId, state);
      log.warn({ stage: stage.id, retry: retries + 1, decision }, 'Retrying stage (inner loop)');
      continue;
    }
    if (result.providerFailure && result.providerFailure.kind !== 'refusal') {
      const detail = `Upstream adapter failure exhausted technical recovery for ${stage.id}: ${result.providerFailure?.kind}`;
      concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'adapter_failure', detail, pendingStageNote: detail, eventFields: () => ({
        iteration: state.currentIteration ?? 1, stageId: stage.id, detail, source: 'scheduler', level: 'warning',
      }) });
      return;
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
  resolvedPrompt = appendApprovalRequestContract(resolvedPrompt, runDirPath, stage.id);
  resolvedPrompt = appendProjectWriteContext(resolvedPrompt, stage);
  resolvedPrompt = appendResearchPathContract(resolvedPrompt, state.research, state.terminalStates);
  if (stage.dynamic_dispatch) {
    resolvedPrompt = appendPlannerAdmissionContract(resolvedPrompt, state.terminalStates);
    resolvedPrompt = appendUnresolvedStageObligationContext(resolvedPrompt, readRunState(projectDir, runId));
  }

  const current = readRunState(projectDir, runId);
  resolvedPrompt = appendGateConstraintAuditContext(resolvedPrompt, stage, allStages, current, runDirPath);

  return resolvedPrompt;
}
