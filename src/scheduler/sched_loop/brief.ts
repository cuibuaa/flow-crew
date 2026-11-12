import { runRecordPath } from '../../run-layout.js';
import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Materialize admitted task metadata and brief configuration, and refuse malformed research/budget inputs before agents execute.
import { BriefAdmissionRecord } from '../../brief-preflight.js';
import { resolveCampaignStorageKey } from '../../campaigns.js';

import { splitBriefFrontmatter } from '../../brief-frontmatter.js';
import { entryWorkflow, parseBriefFrontmatter } from '../sched_admission/brief-contract.js';
import { WorkflowConfig } from '../sched_admission/configuration.js';
import { log } from '../sched_admission/shared.js';
import { StoreState, readRunState, writeRunState } from '../../store.js';
import { writeCampaignEntry } from './services.js';
import { writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalArtifactIdentity } from '../../terminal-artifact-status.js';

export function configureWorkflowBrief(
  workflow: WorkflowConfig, projectDir: string, runId: string, runDirPath: string,
  maxIterations: number, admission: { resumingExistingRun: boolean; briefWasAdmitted: boolean }, taskDescription?: string,
  campaignId?: string,
  inheritCampaignContext = true, briefAdmission?: BriefAdmissionRecord,
): {kind: 'settled'; state: StoreState} | {kind: 'configured'; taskDescription?: string; researchState?: StoreState} {
  const { resumingExistingRun, briefWasAdmitted: admittedBrief } = admission;
  let researchState: StoreState | undefined;
  if (taskDescription || campaignId || briefAdmission) {
    const initState = readRunState(projectDir, runId);
    if (taskDescription && !resumingExistingRun && !admittedBrief) {
      initState.taskDescription = taskDescription;
      // The run owns the brief consumed by workers and reruns.
      try {
        const briefDest = runRecordPath(runDirPath, 'task_brief.md');
        if (!existsSync(briefDest)) {
          writeFileSync(briefDest, taskDescription, 'utf-8');
        }
      } catch { /* non-critical */ }
    }
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
  const briefPath = runRecordPath(runDirPath, 'task_brief.md');
  if (taskDescription !== undefined || existsSync(briefPath)) {
    const briefContent = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : taskDescription!;
    if (briefContent.trim()) {
      const needsConfiguration = !admittedBrief || readRunState(projectDir, runId).briefConfigured === false;
      const parsed = !needsConfiguration
        ? { stripped: splitBriefFrontmatter(briefContent)?.body ?? briefContent } as ReturnType<typeof parseBriefFrontmatter>
        : parseBriefFrontmatter(briefContent);
      const { terminalStates, research, stripped } = parsed;
      const { frontmatterError } = parsed;
      const route = entryWorkflow(parsed);
      const error = route.error ?? (workflow.name === 'research' ? frontmatterError : undefined);
      if (error) {
        const state = readRunState(projectDir, runId);
        concludeRun(state, { status: 'failed', reasonCode: 'workflow_refused', detail: `Workflow refused: ${error}`, writeCampaignEntry });
        log.error({ runId, error }, 'workflow refused before dispatch');
        return { kind: 'settled', state };
      }
      taskDescription = stripped || briefContent;
      const s = readRunState(projectDir, runId);
      if (needsConfiguration) {
        // Commit metadata and completion together. Stored bytes alone do not
        // prove configuration finished before an interrupted preparation.
        s.taskDescription ??= briefContent;
        if (briefAdmission) s.briefAdmission ??= briefAdmission;
        if (!resumingExistingRun) s.maxContinuations = parsed.maxContinuations;
        if (terminalStates) {
          s.terminalStates = terminalStates;
          if (!resumingExistingRun) s.terminalArtifactBaselines = Object.fromEntries(
            Object.values(terminalStates).flatMap(entry => entry.paths)
              .map(path => [path, terminalArtifactIdentity(join(projectDir, path), projectDir)]));
        }
        if (research) s.research = research;
        if (parsed.outputs) s.declaredOutputs = parsed.outputs;
        s.briefConfigured = true;
        writeRunState(projectDir, runId, s);
        if (terminalStates) log.info({ runId, statuses: Object.keys(terminalStates) }, 'Terminal-state config loaded from brief frontmatter');
        if (research) log.info({ runId, replicates: research.measurement.replicates }, 'Research config loaded from brief frontmatter');
      }
      if (s.declaredOutputs?.length) taskDescription += `\n\nDeclared outputs (required by the brief):\n${s.declaredOutputs.map(output => `- ${output.path} (${output.expectedType})`).join('\n')}\nGuidance cannot remove these obligations. Report conflicting actual constraints rather than silently overriding either one.`;
      if (s.research?.measurement) researchState = s;
      if (parsed.frontmatterError) log.warn({ runId, frontmatterError: parsed.frontmatterError }, 'brief frontmatter failed to parse — any terminal_states/research config in it was ignored');

    }
  }
  return {kind: 'configured', taskDescription, researchState};
}
