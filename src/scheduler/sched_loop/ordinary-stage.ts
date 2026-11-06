import { unlinkSync } from '../../engine-fs.js';
import { recordGateValidationDelta } from '../sched_settlement/gate-validation.js';
import { decisionSchema } from '../../decision-graph.js';
import { decisionInput, focusedReviewInput } from '../../decision-context.js';
import { buildGateFixCorrectionContract, gateArchiveCoordinate, appendGateEvidenceInstruction } from '../sched_settlement/gate-archives.js';
// Boundary: Prepare and execute one ordinary stage with admitted prompt/context, shared attempt budgets, session rules and a supplied live write guard.
import { Adapter, AgentConfig, RunResult } from '../../adapters/base.js';
import { loadAdapterByName } from '../../adapters/loader.js';
import { AttemptDeadlineClock, TechnicalRetryBudgetState } from '../../attempt-deadline.js';
import { formatCampaignContextBlock, selectRelevantCampaignContext } from '../../campaign-context.js';
import { summarizeLedger } from '../../campaign-ledger.js';
import { readCampaignEntries, resolveCampaignStorageKey } from '../../campaigns.js';
import { isSessionReuseEnabled } from '../../config.js';
import { summarizeContext } from '../../context-inventory.js';
import { listCheckTypes } from '../../reality-gate/index.js';
import { StageConfig, parseAgent } from '../sched_admission/configuration.js';
import { buildRetryPreamble } from '../sched_admission/dispatch-retry.js';
import { applyBasePrompt, loadBasePrompt } from '../sched_admission/dispatch.js';
import { gateContinuationSessionForStage, sessionResumeForStage, shouldPreserveSession } from '../sched_admission/sessions.js';
import { log } from '../sched_admission/shared.js';
import { checkCampaignHealth } from '../sched_policy/campaign.js';
import { appendAttemptDeadlineContract } from '../sched_policy/prompt-contracts.js';
import { gateReviewedAuthorIds, isGateReviewed, isResearchOutcomeGate } from '../sched_settlement/gate-recovery.js';
import { appendStageExecutionContracts, createSchedulerTechnicalRetryState, prepareSchedulerTechnicalAttempt, recordSchedulerTechnicalAttemptResult, stageInitialTimeout } from '../sched_settlement/stage-execution.js';
import { StoreState, runDir } from '../../store.js';
import { runStage } from '../../worker.js';
import { stageRecordSchema } from '../../handoff.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export async function executeOrdinaryStage(
  stage: StageConfig, sorted: StageConfig[], state: StoreState,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  technicalRetries: Map<string, TechnicalRetryBudgetState>,
  skills?: string, taskDescription?: string, availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
  settlementBoundary?: (phase: 'attempt_closed') => Promise<void>,
): Promise<{stage: StageConfig; result: RunResult; currentRetries: number}> {
      if (!agents.has(stage.role)) {
        const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
        const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
        agents.set(stage.role, applyBasePrompt(parseAgent(raw), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      if (stage.is_gate && state.decisionGraph?.enabled[stage.id] && existsSync(join(runDirPath, `verdict_${stage.id}.json`))) unlinkSync(join(runDirPath, `verdict_${stage.id}.json`));
      const initialTimeout = stageInitialTimeout();
      let technicalRetry = technicalRetries.get(stage.id);
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      log.info({ stage: stage.id, role: stage.role }, 'Running stage');

      let availableRoles: string | undefined;
      let availableChecks: string | undefined;
      let resultSchema: string | undefined;
      let contextInventory: string | undefined;
      let ledgerDigest: string | undefined;
      if (stage.dynamic_dispatch) {
        // Context primitive: inject the on-disk data/asset inventory so the planner's Propose
        // step works from the real world-model (never signposts acquiring data already present).
        contextInventory = summarizeContext(projectDir, state.research?.contextRoots ?? ['data']);
        // Ledger primitive: inject the campaign's tried directions so Propose does
        // not repeat prior work. Always computed (not gated by --no-inherit: it is the compact
        // dedup ledger, not the verbose narrative context that flag suppresses).
        ledgerDigest = summarizeLedger(projectDir, state.campaignId);
        availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
        // Inject the self-describing deterministic-check vocabulary so the planner
        // composes gates from real checks, not only free-text QA prose.
        availableChecks = (await listCheckTypes()).map((c) => `- ${c.type}: ${c.description} (params: ${c.params})`).join('\n');
        // Single-source the round_result output contract: the planner's checks must reference
        // THIS schema (not invent fields). The engine enforces the same schema per round (Gate #0).
        if (state.research?.resultSchema) resultSchema = JSON.stringify(state.research.resultSchema, null, 2);
      }

      let resolvedPrompt = stage.prompt_template;
      if (!resolvedPrompt) {
        resolvedPrompt = (stage.depends_on ?? []).length === 0
          ? (taskDescription?.trim() || taskDescription || '') + '\nProject: ' + projectDir
          : (taskDescription ?? '');
      }

      // Entry stages consume the task text captured and parsed at admission.
      // Re-reading task_brief.md here would let a later sidecar edit replace
      // the exact bytes that the launcher already admitted.
      if (stage.dynamic_dispatch && (stage.depends_on ?? []).length === 0) {
        const admittedTask = taskDescription?.trim();
        if (admittedTask && !stage.prompt_template?.trim()) {
          resolvedPrompt = admittedTask + '\nProject: ' + projectDir;
        }
        // Campaign context: prepend only fresh, non-terminal, active-phase history.
        // --campaign-context=skip (and its legacy alias) suppresses this verbose block;
        // campaign ownership, telemetry and the compact tried-direction ledger remain intact.
        const campaignStorageKey = resolveCampaignStorageKey(state);
        if (campaignStorageKey && state.inheritCampaignContext !== false) {
          const entries = readCampaignEntries(projectDir, campaignStorageKey);
          if (entries.length > 0) {
            const selection = selectRelevantCampaignContext(entries);
            const summaryPaths: string[] = [];
            for (const previousRunId of selection.summaryRunIds) {
              const prevRunDir = runDir(projectDir, previousRunId);
              const iterLog = join(prevRunDir, 'evidence-ledger.jsonl');
              if (existsSync(iterLog) && !summaryPaths.includes(iterLog)) summaryPaths.push(iterLog);
            }
            const alert = checkCampaignHealth(selection.entries);
            const context = formatCampaignContextBlock({
              campaignLabel: state.campaignName ?? state.campaignId ?? campaignStorageKey,
              selection,
              summaryPaths,
              alert,
            });
            if (context) resolvedPrompt = context + resolvedPrompt;
          }
        }
      }

      if (stage.dynamic_dispatch && state.decisionGraph?.replan) {
        resolvedPrompt += `\n\n# Replan within this iteration\n${JSON.stringify({ current_revision: state.queryState?.planRevision, admitted_stages: state.planControl?.stages,
          progress: Object.fromEntries(Object.entries(state.stages).map(([id, status]) => [id, { status: status.status, attempts: status.attempts?.map(attempt => ({ index: attempt.index, startedAt: attempt.startedAt, completedAt: attempt.completedAt, status: attempt.status, tokenUsage: attempt.tokenUsage })) }])),
          decisions: state.decisionGraph.records, budgets: { iteration: state.currentIteration, maximum_iterations: state.maxIterations, started_at: state.startedAt }, reason: state.decisionGraph.replan.reason })}\nReturn the complete non-bootstrap plan in dispatch.yaml. Retain every executed stage exactly as admitted and preserve all result duties. This is a new revision, not a new iteration; all spent work and clocks carry over.`;
      }
      // Pivot context: inject into planner prompt when research injection is active
      if (state.researchInjection && (stage.depends_on ?? []).length === 0) {
        resolvedPrompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${state.researchInjection.alertType}. ${state.researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation.\n\n` + resolvedPrompt;
      }

      if (!stage.is_gate && stage.retry_to?.length && state.gateRetryRound?.iteration === (state.currentIteration ?? 1)) {
        resolvedPrompt = `${buildGateFixCorrectionContract(runDirPath, stage.retry_to, gateArchiveCoordinate(state.currentIteration ?? 1, state.gateRetryRound.round))}\n\n${resolvedPrompt}`;
      }
      resolvedPrompt = appendStageExecutionContracts(resolvedPrompt, stage, sorted, state, projectDir, runId, runDirPath);

      if (stage.is_gate) {
        resolvedPrompt = appendGateEvidenceInstruction(resolvedPrompt, runDirPath, stage.id, state.currentIteration ?? 1);
      }

      const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
      const sessionReuseEnabled = isSessionReuseEnabled();
      const resumeSession = gateContinuationSessionForStage(stage, runDirPath, (state.stages[stage.id]?.attempts?.length ?? 0) > 0, stageAdapter.sessionKind) ?? sessionResumeForStage(stage, sorted, state, runDirPath, sessionReuseEnabled, stageAdapter.sessionKind);
      if (!technicalRetry) {
        technicalRetry = createSchedulerTechnicalRetryState(
          initialTimeout,
          state.stages[stage.id],
          true,
        );
        technicalRetries.set(stage.id, technicalRetry);
      }
      const prepared = prepareSchedulerTechnicalAttempt(technicalRetry);
      if (currentRetries > 0) {
        resolvedPrompt = `${buildRetryPreamble(currentRetries, prepared.budgetMs, runDirPath, stage.id, prepared.retryContext)}\n\n${resolvedPrompt}`;
      }
      resolvedPrompt = appendAttemptDeadlineContract(resolvedPrompt, prepared.budgetMs);
      if (stage.decision?.kind === 'review') await recordGateValidationDelta(projectDir, runId, stage.id);
      const coordinate = state.gateRetryRound;
      const roundDiffPath = coordinate ? join(runDirPath, 'gate_reevaluation', `iteration_${coordinate.iteration}`, `round_${coordinate.round}`, 'repair_diff.json') : undefined;
      let fixStageIds: string[] | undefined;
      if (roundDiffPath && existsSync(roundDiffPath)) fixStageIds = JSON.parse(readFileSync(roundDiffPath, 'utf8')).repairStageIds;
      const reviewDecision = sorted.find(s => s.decision?.kind === 'review' && s.decision.successors.includes(stage.id));
      if (reviewDecision?.decision?.successors[1] === stage.id) resolvedPrompt += `\n\n${focusedReviewInput(projectDir, runDirPath, state, reviewDecision.id, stage)}\nPerform the full independent review; these risks do not narrow coverage.`;
      const isolatedInput = stage.decision?.kind === 'shape' || stage.decision?.kind === 'review'
        ? decisionInput(stage, projectDir, runDirPath, state)
        : reviewDecision?.decision?.successors[0] === stage.id
          ? { system: 'You are an independent read-only reviewer. Run independent targeted experiments in private scratch, evaluate every assigned brief criterion, and return the gate verdict. Do not durably modify the reviewed project. Never read author transcripts, sessions or self-assessment.', user: focusedReviewInput(projectDir, runDirPath, state, reviewDecision.id, stage) } : undefined;
      const result = await runStage(stageAdapter, {
        stageId: stage.id,
        role: ['shape', 'review'].includes(stage.decision?.kind ?? '') ? { ...agent, tools: [] } : agent,
        dependsOn: stage.depends_on ?? [],
        promptTemplate: resolvedPrompt,
        artifactObligationTemplate: stage.prompt_template,
        artifactContract: stage.artifact_contract,
        isolatedInput,
        decisionResult: Boolean(stage.decision && !stage.is_gate),
        outputSchema: stage.decision && !stage.is_gate ? decisionSchema(stage) : stageRecordSchema({ isGate: stage.is_gate,
          criterionRefs: stage.criterion_refs, extendedVerdict: Boolean(stage.artifact_contract?.produces.some(output => output.path === `verdict_${stage.id}.json`) || state.campaignStorageKey || state.research || existsSync(join(runDirPath, 'gate_contract.json')) || existsSync(join(runDirPath, 'supervisor_guidance.md'))) }),
        planRevision: state.queryState?.planRevision,
        artifactStatuses: state.stages,
        timeout_ms: prepared.budgetMs,
        ...(attemptDeadlineClockFactory ? { deadlineClock: attemptDeadlineClockFactory() } : {}),
        projectDir,
        runId,
        runDir: runDirPath,
        retries: currentRetries,
        skills,
        stageSkills: stage.skills,
        availableRoles,
        availableChecks,
        availableSkills,
        resultSchema,
        contextInventory,
        ledgerDigest,
        taskDescription: taskDescription || state.taskDescription,
        isGate: stage.is_gate,
        gateContext: { authorIds: fixStageIds ?? gateReviewedAuthorIds(stage, sorted), fixStageIds, roundDiffPath },
        gateReviewed: isGateReviewed(stage, sorted),
        dynamicDispatch: stage.dynamic_dispatch,
        researchOutcomeGate: isResearchOutcomeGate(stage, sorted, state.research),
        criterionRefs: stage.criterion_refs,
        resumeSessionId: isolatedInput ? undefined : resumeSession?.sessionId,
        sessionOwnerStageId: isolatedInput ? undefined : resumeSession?.ownerStageId,
        preserveSession: isolatedInput ? false : shouldPreserveSession(stage, sorted, sessionReuseEnabled),
        settlementBoundary,
      });
      recordSchedulerTechnicalAttemptResult(technicalRetry, result, prepared.budgetMs);
      return { stage, result, currentRetries };
}
