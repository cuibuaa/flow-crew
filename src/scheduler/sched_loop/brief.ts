// Boundary: Materialize admitted task metadata and brief configuration, and refuse malformed research/budget/program inputs before agents execute.
import { BriefAdmissionRecord } from '../../brief-preflight.js';
import { resolveCampaignStorageKey } from '../../campaigns.js';
import { recordRunEvent } from '../../run-events.js';
import { assessResearchIterationBudget, autoSelectedWorkflow, checkProgramSafeguards, parseBriefFrontmatter } from '../sched_admission/brief-contract.js';
import { WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { StoreState, readRunState, writeRunState } from '../../store.js';
import { writeCampaignEntry } from './services.js';
import { writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginResearchInputGeneration } from '../../research-candidate.js';

export function configureWorkflowBrief(
  workflow: WorkflowConfig, projectDir: string, runId: string, runDirPath: string,
  maxIterations: number, resumingExistingRun: boolean, taskDescription?: string,
  autoApprove?: boolean, campaignId?: string,
  inheritCampaignContext = true, briefAdmission?: BriefAdmissionRecord,
): {kind: 'settled'; state: StoreState} | {kind: 'configured'; taskDescription?: string} {
  if (taskDescription || autoApprove || campaignId || briefAdmission) {
    const initState = readRunState(projectDir, runId);
    if (taskDescription && !resumingExistingRun) {
      initState.taskDescription = taskDescription;
      // The run owns the brief consumed by workers and reruns.
      try {
        const briefDest = join(runDirPath, 'task_brief.md');
        if (!existsSync(briefDest)) {
          writeFileSync(briefDest, taskDescription, 'utf-8');
        }
      } catch { /* non-critical */ }
    }
    if (autoApprove) initState.autoApprove = true;
    if (briefAdmission) initState.briefAdmission = briefAdmission;
    if (campaignId) {
      initState.campaignId = campaignId;
      initState.campaignName = campaignId;
      initState.campaignStorageKey = resolveCampaignStorageKey({ campaignId });
    }
    if (inheritCampaignContext === false) initState.inheritCampaignContext = false;
    writeRunState(projectDir, runId, initState);
  }

  // Use full task brief as taskDescription for template substitution in dispatched stages.
  // Also parse `---` YAML frontmatter for terminal_states config (research-exploration
  // briefs declare ceiling_report.md / escalation_note.md as valid completions).
  // The frontmatter is stripped from the brief before it reaches stage prompts so the
  // planner doesn't waste tokens reading scheduler-internal config.
  const briefPath = join(runDirPath, 'task_brief.md');
  if (taskDescription !== undefined || existsSync(briefPath)) {
    const briefContent = (taskDescription !== undefined
      ? taskDescription
      : readFileSync(briefPath, 'utf-8')).trim();
    if (briefContent) {
      const parsed = parseBriefFrontmatter(briefContent);
      const { terminalStates, program, research, outputs, stripped } = parsed;
      const route = autoSelectedWorkflow(parsed, workflow.name);
      const error = route.error ?? (workflow.name === 'research' ? parsed.frontmatterError : undefined);
      if (error) {
        const state = readRunState(projectDir, runId);
        state.status = 'failed';
        state.failureReason = `Workflow refused: ${error}`;
        state.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, state);
        writeCampaignEntry(projectDir, state);
        log.error({ runId, error }, 'workflow refused before dispatch');
        return { kind: 'settled', state };
      }
      taskDescription = stripped || briefContent;
      if (outputs?.length) taskDescription += `\n\nDeclared outputs (required by the brief):\n${outputs.map(output => `- ${output.path} (${output.expectedType})`).join('\n')}\nGuidance cannot remove these obligations. Report conflicting actual constraints rather than silently overriding either one.`;
      if (terminalStates || program || research || outputs) {
        const s = readRunState(projectDir, runId);
        if (terminalStates) s.terminalStates = terminalStates;
        if (program) s.program = program;
        if (research) s.research = research;
        if (outputs) s.declaredOutputs = outputs;
        beginResearchInputGeneration(projectDir, s);
        writeRunState(projectDir, runId, s);
        if (terminalStates) log.info({ runId, statuses: Object.keys(terminalStates) }, 'Terminal-state config loaded from brief frontmatter');
        if (program) log.info({ runId, program: program.name, phase: program.phase }, 'Program config loaded from brief frontmatter');
        if (research) log.info({ runId, policy: research.policy, baseline: research.baseline }, 'Research config loaded from brief frontmatter');
      }
      // Consistency check: the `--workflow research` flag and the `research:`
      // frontmatter block should agree. The block is the precise expression of
      // intent, so we WARN on mismatch rather than fail.
      const isResearchWorkflow = workflow.name === 'research';
      if (isResearchWorkflow && !research) {
        log.warn({ runId }, 'workflow=research but brief has no `research:` block — research loop needs baseline+policy; falling back to plain dispatch');
      } else if (research && !isResearchWorkflow) {
        log.warn({ runId, workflow: workflow.name }, 'brief has a `research:` block but workflow is not `research` — research advance gate still active, but consider --workflow research for clarity');
      } else if (parsed.frontmatterError) {
        log.warn({ runId, frontmatterError: parsed.frontmatterError }, 'brief frontmatter failed to parse — any terminal_states/program/research config in it was ignored');
      }
      const budgetDefaults = loadDefaults();
      const budgetAssessment = assessResearchIterationBudget(research, maxIterations, {
        attemptTimeoutMs: budgetDefaults.timeout_ms,
        technicalRetries: budgetDefaults.stage_technical_retries,
      });
      if (briefAdmission && !budgetAssessment.pass) {
        const s = readRunState(projectDir, runId);
        s.status = 'failed';
        s.failureReason = `Research budget admission refused: ${budgetAssessment.reason}. Adjust the named authored budget or its named engine binding before launch.`;
        s.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, s);
        recordRunEvent(projectDir, runId, {
          type: 'admission_rejected', runId, timestamp: s.completedAt,
          detail: s.failureReason,
        });
        return { kind: 'settled', state: s };
      }
      // Program safeguard pre-check at run start. If violated, refuse to start
      // and record the failure in run state for the orchestrator and dashboard.
      if (program) {
        const violation = checkProgramSafeguards(projectDir, program);
        if (violation) {
          const s2 = readRunState(projectDir, runId);
          s2.status = 'failed';
          s2.failureReason = `Program safeguard: ${violation}`;
          s2.completedAt = new Date().toISOString();
          writeRunState(projectDir, runId, s2);
          log.error({ runId, violation }, 'Program safeguard violated; refusing to start');
          return { kind: 'settled', state: s2 };
        }
      }
    }
  }
  return {kind: 'configured', taskDescription};
}
