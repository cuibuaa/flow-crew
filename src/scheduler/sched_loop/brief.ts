import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Materialize admitted task metadata and brief configuration, and refuse malformed research/budget inputs before agents execute.
import { BriefAdmissionRecord } from '../../brief-preflight.js';
import { resolveCampaignStorageKey } from '../../campaigns.js';
import { recordRunEvent } from '../../run-events.js';
import { assessResearchIterationBudget, autoSelectedWorkflow, parseBriefFrontmatter } from '../sched_admission/brief-contract.js';
import { WorkflowConfig, loadDefaults } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { StoreState, readRunState, writeRunState } from '../../store.js';
import { writeCampaignEntry } from './services.js';
import { writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalArtifactIdentity } from '../../terminal-artifact-status.js';
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
      initState.campaignStorageKey = resolveCampaignStorageKey({ campaignId, projectDir });
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
      const { terminalStates, research, outputs, stripped } = parsed;
      // An already selected library workflow retains its recorded metadata
      // tolerance; the command entrances validate the full brief before launch.
      const { frontmatterError, ...workflowDeclaration } = parsed;
      const route = autoSelectedWorkflow(workflowDeclaration, workflow.name);
      const error = route.error ?? (workflow.name === 'research' ? frontmatterError : undefined);
      if (error) {
        const state = readRunState(projectDir, runId);
        concludeRun(state, { status: 'failed', reasonCode: 'workflow_refused', detail: `Workflow refused: ${error}`, writeCampaignEntry });
        log.error({ runId, error }, 'workflow refused before dispatch');
        return { kind: 'settled', state };
      }
      taskDescription = stripped || briefContent;
      if (outputs?.length) taskDescription += `\n\nDeclared outputs (required by the brief):\n${outputs.map(output => `- ${output.path} (${output.expectedType})`).join('\n')}\nGuidance cannot remove these obligations. Report conflicting actual constraints rather than silently overriding either one.`;
      if (terminalStates || research || outputs) {
        const s = readRunState(projectDir, runId);
        if (terminalStates) {
          s.terminalStates = terminalStates;
          if (!resumingExistingRun) s.terminalArtifactBaselines = Object.fromEntries(
            Object.values(terminalStates).flatMap(entry => entry.paths)
              .map(path => [path, terminalArtifactIdentity(join(projectDir, path), projectDir)]));
        }
        if (research) s.research = research;
        if (outputs) s.declaredOutputs = outputs;
        beginResearchInputGeneration(projectDir, s);
        writeRunState(projectDir, runId, s);
        if (terminalStates) log.info({ runId, statuses: Object.keys(terminalStates) }, 'Terminal-state config loaded from brief frontmatter');
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
        log.warn({ runId, frontmatterError: parsed.frontmatterError }, 'brief frontmatter failed to parse — any terminal_states/research config in it was ignored');
      }
      const budgetDefaults = loadDefaults();
      const budgetAssessment = assessResearchIterationBudget(research, maxIterations, {
        attemptTimeoutMs: budgetDefaults.default_timeout_ms,
        technicalRetries: budgetDefaults.stage_technical_retries,
      });
      if (briefAdmission && !budgetAssessment.pass) {
        const s = readRunState(projectDir, runId);
        concludeRun(s, { status: 'failed', reasonCode: 'admission_refused',
          detail: `Research budget admission refused: ${budgetAssessment.reason}. Adjust the named authored budget or its named engine binding before launch.` });
        recordRunEvent(projectDir, runId, {
          type: 'admission_rejected', runId, timestamp: s.completedAt!,
          detail: s.failureReason,
        });
        return { kind: 'settled', state: s };
      }
    }
  }
  return {kind: 'configured', taskDescription};
}
