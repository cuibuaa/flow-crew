import { concludeRun } from '../sched_policy/run-completion.js';
import { runRecordPath } from '../../run-layout.js';
// Boundary: Materialize admitted task metadata and brief configuration, and refuse malformed research/budget inputs before agents execute.
import { admittedContract, type BriefAdmissionRecord } from '../../brief-preflight.js';
import { resolveCampaignStorageKey } from '../../campaigns.js';

import { splitBriefFrontmatter } from '../../brief-frontmatter.js';
import { entryWorkflow, declarationConfiguration, captureTerminalReceiptBaselines, terminalReceiptGlob } from '../sched_admission/brief-contract.js';
import { WorkflowConfig } from '../sched_admission/configuration.js';
import { StoreState, readRunState, writeRunState } from '../../store.js';
import { writeFileSync } from '../../engine-fs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_OWNERSHIP_UNVERIFIED, terminalArtifactIdentity } from '../../terminal-artifact-status.js';

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
    if (briefAdmission && !admittedBrief) initState.briefAdmission = briefAdmission;
    if (campaignId) {
      initState.campaignId = campaignId;
      initState.campaignName = campaignId;
      initState.campaignStorageKey = resolveCampaignStorageKey({ campaignId, projectDir });
    }
    if (inheritCampaignContext === false) initState.inheritCampaignContext = false;
    writeRunState(projectDir, runId, initState);
  }

  const s = readRunState(projectDir, runId);
  const contract = admittedContract(s.briefAdmission);
  const parsed = declarationConfiguration(contract.declaration);
  const error = entryWorkflow(parsed).error;
  if (error) throw new Error(error);
  const { terminalStates, research } = parsed;
  const needsConfiguration = !s.briefConfigured;
  s.maxContinuations = parsed.maxContinuations;
  s.terminalStates = terminalStates;
  s.research = research;
  s.declaredOutputs = parsed.outputs;
  if (terminalStates && needsConfiguration && !resumingExistingRun && s.terminalArtifactBaselines) {
    s.terminalArtifactBaselines = Object.fromEntries(Object.values(terminalStates).flatMap(entry => entry.paths)
      .map(path => [path, terminalArtifactIdentity(join(projectDir, path), projectDir)]));
    s.terminalReceiptBaselines = captureTerminalReceiptBaselines(projectDir, Object.values(terminalStates));
  }
  if (terminalStates && Object.values(terminalStates).some(entry => entry.paths.some(path => !s.terminalArtifactBaselines?.[path])
    || (terminalReceiptGlob(entry) && !s.terminalReceiptBaselines?.[terminalReceiptGlob(entry)!]))) {
    return { kind: 'settled', state: concludeRun(s, { status: 'incomplete', reasonCode: ARTIFACT_OWNERSHIP_UNVERIFIED,
      detail: 'Terminal ownership cannot be verified without the recorded launch content baseline.' }) };
  }
  s.briefConfigured = true;
  writeRunState(projectDir, runId, s);
  // An explicitly acknowledged continuation can update model instructions,
  // while every machine-enforced obligation remains the original declaration.
  const modelBrief = s.briefContinuationAdmission ? admittedContract(s.briefContinuationAdmission).brief : contract.brief;
  taskDescription = splitBriefFrontmatter(modelBrief)?.body ?? modelBrief;
  if (s.declaredOutputs?.length) taskDescription += `\n\nDeclared outputs (required by the brief):\n${s.declaredOutputs.map(output => `- ${output.path} (${output.expectedType})`).join('\n')}\nGuidance cannot remove these obligations. Report conflicting actual constraints rather than silently overriding either one.`;
  if (research) researchState = s;
  return {kind: 'configured', taskDescription, researchState};
}
