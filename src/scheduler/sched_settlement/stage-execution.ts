import { publishRunCompletion } from '../sched_policy/run-completion.js';
import { isRetryableAdapterFailure } from '../../adapters/failure.js';
import { appendGateEvidenceInstruction } from './gate-archives.js';
// Boundary: Technical attempt budgets and one repair/re-evaluation stage execution; uses existing worker and typed prompt/session/validation boundaries.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { loadAdapterByName } from '../../adapters/loader.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState, createTechnicalRetryBudgetState, nextTechnicalRetryBudget, transitionTechnicalRetryBudget } from '../../attempt-deadline.js';
import { isSessionReuseEnabled } from '../../config.js';
import { LiveConstraintGuardFactory } from '../../live-constraint-guard.js';
import { RUN_STATUS, STAGE_STATUS, StageAttemptSettlementError, StageStatus, StoreState, isPendingStageStatus, isRunningStageStatus, readRunState, readStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { appendTraceEvent } from '../../trace.js';
import { freshRunningStageProjection, runStage } from '../../worker.js';
import { stageRecordSchema } from '../../handoff.js';
import { markLeftoverStagesSkipped } from '../sched_admission/brief-contract.js';
import { StageConfig, WorkflowConfig, configuredTechnicalRetryLimit, failureRetryLimit, loadDefaults, parseAgent } from '../sched_admission/configuration.js';
import { buildRetryPreamble } from '../sched_admission/dispatch-retry.js';
import { applyBasePrompt, buildRoleRegistry, loadBasePrompt } from '../sched_admission/dispatch.js';
import { gateContinuationSessionForStage, sessionResumeForStage, shouldPreserveSession } from '../sched_admission/sessions.js';
import { log } from '../sched_admission/shared.js';
import { appendApprovalRequestContract, appendAttemptDeadlineContract, appendGateConstraintAuditContext, appendPlannerAdmissionContract, appendResearchPathContract, appendScopeRevisionContract } from '../sched_policy/prompt-contracts.js';
import { appendScopePlanningInput } from '../sched_scope/scope-planning.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendUnresolvedStageObligationContext } from './completion.js';
import { gateArchiveArtifactPath, buildGateFixCorrectionContract, gateArchiveCoordinate } from './gate-archives.js';
import { isGateReviewed, isResearchOutcomeGate } from './gate-recovery.js';

export function stageInitialTimeout(): number {
  return loadDefaults().timeout_ms;
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
  const priorTimedOut = retries > 0 && (
    priorTimeout?.terminationCause === 'attempt_timeout'
    || priorAttempt?.error?.startsWith('timed out after') === true
    || priorStatus?.error?.startsWith('timed out after') === true
  );
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
  result: Pick<RunResult, 'effectiveTimeoutMs' | 'timedOut' | 'timeoutTerminationCause' | 'adapterFailureKind'>,
  preparedBudgetMs: number,
): boolean {
  const effectiveBudgetMs = result.effectiveTimeoutMs ?? preparedBudgetMs;
  const retryableTimeout = result.timedOut === true
    && result.timeoutTerminationCause === 'attempt_timeout';
  transitionTechnicalRetryBudget(chain, retryableTimeout
    ? { type: 'attempt_timed_out', effectiveBudgetMs }
    : { type: 'attempt_finished', effectiveBudgetMs });
  return retryableTimeout || result.adapterFailureKind !== undefined;
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
  liveConstraintGuardFactory?: LiveConstraintGuardFactory,
  settlementBoundary?: (phase: 'child_closed' | 'attempt_closed') => Promise<boolean>,
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
      existsSync(gateArchiveArtifactPath(runDirPath, archiveCoordinate, gateId, 'output', 'read')),
    );
    if (!stage.is_gate && innerRetry > 0) {
      // Build references to the gate verdicts and outputs that triggered this retry
      const gateRefs = activeRetryGateIds.map(gid =>
        `- Verdict: ${gateArchiveArtifactPath(runDirPath, archiveCoordinate, gid, 'verdict', 'read')}\n- QA output: ${gateArchiveArtifactPath(runDirPath, archiveCoordinate, gid, 'output', 'read')}`
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
  let retries = 0;
  let failureRetries = 0;
  const sessionReuseEnabled = isSessionReuseEnabled();
  const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
  const gateSession = gateContinuationSessionForStage(stage, runDirPath, innerRetry !== undefined, stageAdapter.sessionKind);
  let result: RunResult | undefined;
  const technicalRetry = createSchedulerTechnicalRetryState(initialTimeout);

  while (true) {
    // A prior technical attempt is completed by runStage() directly in the
    // per-stage status file. Re-read that authoritative ledger before marking
    // the next attempt running; the scheduler's in-memory state predates the
    // call and must never overwrite a just-recorded timeout/failure.
    let latestStageStatus = state.stages[stage.id];
    try { latestStageStatus = readStageStatus(projectDir, runId, stage.id); } catch { /* first execution */ }
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
      projectWriteScope: stage.scope ?? [],
      liveConstraintGuardFactory,
      settlementBoundary,
    });

    if (result.exitCode === 125 && /^ENGINE_STATE_(?:TAMPERED|REFUSED):/.test(result.friendlyError ?? '')) {
      throw new StageAttemptSettlementError(stage.id, readStageStatus(projectDir, runId, stage.id).attempts!.at(-1)!.index, new Error(result.friendlyError));
    }

    const retryableTechnicalFailure = recordSchedulerTechnicalAttemptResult(
      technicalRetry,
      result,
      prepared.budgetMs,
    );

    if (retryableTechnicalFailure) {
      if (retries < maxTechnicalRetries && isRetryableAdapterFailure(result.adapterFailureKind)) {
        retries++;
        log.warn(
          { stage: stage.id, retry: retries, adapterFailureKind: result.adapterFailureKind },
          result.adapterFailureKind
            ? 'Retrying adapter-failed stage (inner loop)'
            : 'Retrying timed-out stage (inner loop)',
        );
        continue;
      }
      if (result.adapterFailureKind) {
        const detail = `Upstream adapter failure exhausted technical recovery for ${stage.id}: ${result.adapterFailureKind}`;
        try { state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id); } catch { /* runStage normally wrote it */ }
        state.status = RUN_STATUS.FAILED;
        state.failureReason = detail;
        state.completedAt = new Date().toISOString();
        markLeftoverStagesSkipped(state, detail);
        publishRunCompletion(state, projectDir, runId, () => ({
          iteration: state.currentIteration ?? 1,
          stageId: stage.id,
          detail,
          source: 'scheduler',
          level: 'warning',
        }));
        return;
      }
      transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });
    }
    // A fix or re-evaluation that failed for an ordinary reason gets the retries an ordinary stage gets in the batch,
    // with its failure in the retry preamble, instead of ending the iteration and discarding the plan.
    if (!retryableTechnicalFailure && result.timeoutTerminationCause !== 'stage_abort' && result.timeoutTerminationCause !== 'supervisor_abort'
      && result.exitCode !== 0 && !result.suspended && failureRetries < maxFailureRetries) {
      failureRetries++;
      retries++;
      log.warn({ stage: stage.id, retry: retries }, 'Retrying failed stage (inner loop)');
      continue;
    }

    break;
  }

  // Stage status is already written to individual status.json by runStage/worker.
  // Record the outcome event using the authoritative per-stage file.
  try {
    const stageStatus = readStageStatus(projectDir, runId, stage.id);
    // Batch reconciliation owns stage_complete/stage_failed emission because a
    // just-accepted scope request or approval may convert this settlement into
    // a suspension before downstream dependencies are released.
    // Record trace evidence for the adapter settlement itself.
    try {
      appendTraceEvent(projectDir, runId, stage.id, {
        timestamp: new Date().toISOString(),
        stageId: stage.id,
        type: 'llm_call',
        inputSummary: `Stage ${stage.id} (${stage.role})`,
        outputSummary: `Completed in ${Math.round((stageStatus.duration_ms ?? 0) / 1000)}s`,
        tokensIn: stageStatus.tokens_in,
        tokensOut: stageStatus.tokens_out,
        costUsd: stageStatus.cost_usd,
        durationMs: stageStatus.duration_ms ?? 0,
      });
    } catch { /* non-fatal */ }
  } catch { /* status file missing — should not happen */ }
  return result;
}


/** Prompt-only enrichment shared by ordinary execution and gate repair. */
export function appendStageExecutionContracts(
  resolvedPrompt: string, stage: StageConfig, allStages: StageConfig[],
  state: Pick<StoreState, 'research' | 'terminalStates' | 'workflowName'>,
  projectDir: string, runId: string, runDirPath: string,
): string {
  resolvedPrompt = appendApprovalRequestContract(resolvedPrompt, runDirPath, stage.id);
  resolvedPrompt = appendScopeRevisionContract(resolvedPrompt, runDirPath, runId, stage);
  resolvedPrompt = appendResearchPathContract(resolvedPrompt, state.research, state.terminalStates);
  if (stage.dynamic_dispatch) {
    resolvedPrompt = appendPlannerAdmissionContract(resolvedPrompt, state.terminalStates);
    resolvedPrompt = appendScopePlanningInput(resolvedPrompt, runDirPath);
    resolvedPrompt = appendUnresolvedStageObligationContext(resolvedPrompt, readRunState(projectDir, runId));
  }

  const current = readRunState(projectDir, runId);
  resolvedPrompt = appendGateConstraintAuditContext(resolvedPrompt, stage, allStages, current, runDirPath);

  return resolvedPrompt;
}
