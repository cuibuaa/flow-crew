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
import { sessionResumeForStage, shouldPreserveSession } from '../sched_admission/sessions.js';
import { log } from '../sched_admission/shared.js';
import { checkCampaignHealth } from '../sched_policy/campaign.js';
import { appendAttemptDeadlineContract } from '../sched_policy/prompt-contracts.js';
import { initializeGateMetricAttempt } from '../sched_scope/gate-attempt.js';
import { createScopeBatchContext } from '../sched_scope/scope-batch.js';
import { buildGateDispatchPreamble } from '../sched_settlement/gate-archives.js';
import { gateReviewedAuthorIds, isGateReviewed, isResearchOutcomeGate } from '../sched_settlement/gate-recovery.js';
import { appendGateMetricInstruction, appendStageExecutionContracts, createSchedulerTechnicalRetryState, gateAttemptCoordinate, prepareSchedulerTechnicalAttempt, recordSchedulerTechnicalAttemptResult, stageInitialTimeout } from '../sched_settlement/stage-execution.js';
import { StoreState, readStageStatus, runDir } from '../../store.js';
import { runStage } from '../../worker.js';
import { stageRecordSchema } from '../../handoff.js';
import { createSchedulerLiveConstraintGuardFactory } from './services.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export async function executeOrdinaryStage(
  stage: StageConfig, sorted: StageConfig[], state: StoreState,
  projectDir: string, runId: string, runDirPath: string, adapter: Adapter,
  agents: Map<string, AgentConfig>, resolvedAgentsDir: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  technicalRetries: Map<string, TechnicalRetryBudgetState>,
  ordinaryScopeContext: ReturnType<typeof createScopeBatchContext>,
  skills?: string, taskDescription?: string, availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
  beforeSettlement?: () => Promise<boolean>,
): Promise<{stage: StageConfig; result: RunResult; currentRetries: number}> {
      if (!agents.has(stage.role)) {
        const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
        if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
        const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
        agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      const initialTimeout = stageInitialTimeout(projectDir);
      const currentGateAttempt = stage.is_gate
        ? gateAttemptCoordinate(state.currentIteration ?? 1)
        : undefined;
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
        // On re-plan, include iteration_log.md reference
        const iterLogPath = join(runDirPath, 'iteration_log.md');
        if (existsSync(iterLogPath)) {
          resolvedPrompt += `\n\nRead ${runDirPath}/iteration_log.md for previous iteration results. Fix the issues identified there.`;
        }
        // Campaign context: prepend only fresh, non-terminal, active-phase history.
        // --campaign-context=skip (and its legacy alias) suppresses this verbose block;
        // campaign ownership, telemetry and the compact tried-direction ledger remain intact.
        const campaignStorageKey = resolveCampaignStorageKey({
          campaignId: state.campaignId,
          campaignStorageKey: state.campaignStorageKey,
          campaignName: state.campaignName,
        });
        if (campaignStorageKey && state.inheritCampaignContext !== false) {
          const entries = readCampaignEntries(projectDir, campaignStorageKey);
          if (entries.length > 0) {
            const selection = selectRelevantCampaignContext(entries);
            const summaryPaths: string[] = [];
            for (const previousRunId of selection.summaryRunIds) {
              const prevRunDir = runDir(projectDir, previousRunId);
              const iterLog = join(prevRunDir, 'iteration_log.md');
              if (existsSync(iterLog) && !summaryPaths.includes(iterLog)) summaryPaths.push(iterLog);
            }
            const triggers = state.campaignTriggers;
            const alert = checkCampaignHealth(selection.entries, triggers);
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

      // Pivot context: inject into planner prompt when research injection is active
      if (state.researchInjection && (stage.depends_on ?? []).length === 0) {
        resolvedPrompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${state.researchInjection.alertType}. ${state.researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation.\n\n` + resolvedPrompt;
      }

      resolvedPrompt = appendStageExecutionContracts(resolvedPrompt, stage, sorted, state, projectDir, runId, runDirPath);

      if (stage.is_gate) {
        let priorAttemptCount = 0;
        try { priorAttemptCount = readStageStatus(projectDir, runId, stage.id).attempts?.length ?? 0; } catch { /* first dispatch */ }
        resolvedPrompt = `${buildGateDispatchPreamble({
          runDirPath,
          gateId: stage.id,
          evaluationRound: priorAttemptCount + 1,
          priorAttemptCount,
          authorIds: gateReviewedAuthorIds(stage, sorted),
        })}\n\n${resolvedPrompt}`;
        resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id, currentGateAttempt!);
      }

      const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
      const sessionReuseEnabled = isSessionReuseEnabled(projectDir);
      const resumeSession = sessionResumeForStage(stage, sorted, state, runDirPath, sessionReuseEnabled);
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
      if (currentGateAttempt) {
        initializeGateMetricAttempt(
          runDirPath,
          stage.id,
          currentGateAttempt.iteration,
          currentGateAttempt.round,
          currentRetries,
        );
      }
      const result = await runStage(stageAdapter, {
        stageId: stage.id,
        role: agent,
        dependsOn: stage.depends_on ?? [],
        promptTemplate: resolvedPrompt,
        artifactObligationTemplate: stage.prompt_template,
        artifactContract: stage.artifact_contract,
        outputSchema: stageRecordSchema({ isGate: stage.is_gate, dynamicDispatch: stage.dynamic_dispatch,
          criterionRefs: stage.criterion_refs, extendedVerdict: Boolean(stage.artifact_contract?.produces.some(output => output.path === `verdict_${stage.id}.json`) || state.research || state.campaignStorageKey || existsSync(join(runDirPath, 'gate_contract.json')) || existsSync(join(runDirPath, 'supervisor_guidance.md'))) }),
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
        gateReviewed: isGateReviewed(stage, sorted),
        dynamicDispatch: stage.dynamic_dispatch,
        researchOutcomeGate: isResearchOutcomeGate(stage, sorted, state.research),
        criterionRefs: stage.criterion_refs,
        resumeSessionId: resumeSession?.sessionId,
        sessionOwnerStageId: resumeSession?.ownerStageId,
        preserveSession: shouldPreserveSession(stage, sorted, sessionReuseEnabled),
        projectWriteScope: stage.scope ?? [],
        beforeSettlement,
        deferSettlement: true,
        liveConstraintGuardFactory: createSchedulerLiveConstraintGuardFactory({
          stage,
          projectDir,
          runId,
          context: ordinaryScopeContext,
        }),
      });
      recordSchedulerTechnicalAttemptResult(technicalRetry, result, prepared.budgetMs);
      return { stage, result, currentRetries };
}
