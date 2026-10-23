import { readGateEvaluation } from '../sched_settlement/gate-verdict.js';
/** Campaign phase readers, review health and iteration/campaign output; receives gate and scope-planning readers. */
import { type CampaignTriggerType, type StoreState, isPausedRunStatus, requireRunArtifactDirectory, runDir, campaignsRoot as storeCampaignsRoot } from '../../store.js';
import { writeFileSync, appendFileSync, mkdirSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CampaignHistoryEntry, canonicalCampaignId, resolveCampaignStorageKey } from '../../campaigns.js';
import { projectPersistenceIdentity } from '../../project-identity.js';
import { type CampaignPhaseMetadata, isTerminalStudyCompletionArtifact } from '../sched_admission/configuration.js';

export interface CampaignWriterServices {
  readGateEvaluation: typeof import('../../scheduler.js').readGateEvaluation;
  readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null;
  pendingScopePlanningInputs(runDirPath: string): readonly { digest: string; stageKind: string; requestedPaths: string[]; rejectionReason: string }[];
}

function phaseMetadataFromArtifact(artifact: unknown, gateId: string): CampaignPhaseMetadata | null {
  if (!artifact || typeof artifact !== 'object') return null;
  const record = artifact as Record<string, unknown>;
  const phase = typeof record.phase === 'string' ? record.phase : undefined;
  const nextPhase = typeof record.nextPhase === 'string'
    ? record.nextPhase
    : typeof record.next_phase === 'string'
      ? record.next_phase
      : undefined;
  const outcome = typeof record.outcome === 'string' ? record.outcome : undefined;
  const artifactSummary = typeof record.artifactSummary === 'string'
    ? record.artifactSummary
    : typeof record.artifact_summary === 'string'
      ? record.artifact_summary
      : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const phaseComplete = typeof record.phaseComplete === 'boolean'
    ? record.phaseComplete
    : typeof record.phase_complete === 'boolean'
      ? record.phase_complete
      : undefined;
  const hasPhaseMetadata = phase !== undefined
    || nextPhase !== undefined
    || outcome !== undefined
    || artifactSummary !== undefined
    || phaseComplete !== undefined;
  if (!hasPhaseMetadata && !isTerminalStudyCompletionArtifact(record)) return null;
  return {
    gate: gateId,
    pass: record.pass === true,
    phase,
    phaseComplete,
    nextPhase,
    outcome,
    artifactSummary,
    reason,
  };
}

function parseGatePhaseMetadata(projectDir: string, state: StoreState, gateId: string): CampaignPhaseMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir(projectDir, state.runId), `verdict_${gateId}.json`), 'utf-8'));
    const metadata = phaseMetadataFromArtifact(parsed, gateId);
    return metadata ? { ...metadata, pass: readGateEvaluation(projectDir, gateId, state.runId)?.pass === true } : null;
  } catch { return null; } // Missing/malformed verdicts cannot establish a phase.
}

export function orderedGateIdsForState(projectDir: string, state: StoreState): string[] {
  const runPath = runDir(projectDir, state.runId);
  if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
    return (state.dispatchedStages as { id: string; is_gate?: boolean }[])
      .filter(s => s.is_gate)
      .map(s => s.id);
  }

  const ids = new Set<string>();
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
    for (const file of files) ids.add(file.replace('verdict_', '').replace('.json', ''));
  } catch { /* non-critical */
    // No verdicts yet.
  }
  return [...ids];
}

export function findCampaignPhaseMetadata(projectDir: string, state: StoreState): CampaignPhaseMetadata | null {
  let latest: CampaignPhaseMetadata | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metadata = parseGatePhaseMetadata(projectDir, state, gateId);
    if (metadata) latest = metadata;
  }
  return latest;
}

export interface CampaignAlert {
  type: CampaignTriggerType;
  action: 'inject_researcher';
  message: string;
}

/** Kept as the scheduler's public type alias for recorded campaign rows. */
export type CampaignEntry = CampaignHistoryEntry;

/** Campaign health observes failed reviews, never invents a principal metric. */
export function checkCampaignHealth(entries: CampaignEntry[]): CampaignAlert | null {
  if (entries.at(-1)?.terminalStudyComplete === true || entries.at(-1)?.workflowSatisfied === true) return null;
  const bySeq = new Map<number, CampaignEntry>();
  for (const entry of entries.filter(entry => entry.gate)) {
    const prior = bySeq.get(entry.seq);
    if (!prior || (entry.iteration ?? 0) > (prior.iteration ?? 0)
        || (entry.iteration ?? 0) === (prior.iteration ?? 0) && entry.timestamp > prior.timestamp) bySeq.set(entry.seq, entry);
  }
  const threshold = 3;
  const recent = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-threshold);
  return recent.length >= threshold && recent.every(e => !e.pass && e.gate === recent[0].gate)
    ? { type: 'repeated_failure', action: 'inject_researcher', message: `${threshold} consecutive failures on gate ${recent[0].gate}` }
    : null;
}

export function createCampaignWriters(services: CampaignWriterServices) {
  const { readGateEvaluation, readTerminalStudyCompletionEvidence, pendingScopePlanningInputs } = services;

  function appendIterationLog(
    projectDir: string,
    runId: string,
    iteration: number,
    state: StoreState,
    dispatchedStageIds: string[],
    baseStageIds?: string[],
    innerRetriesUsed?: number,
    maxInnerRetries?: number,
  ): void {
    const runDirPath = requireRunArtifactDirectory(projectDir, runId);
    const logPath = join(runDirPath, 'iteration_log.md');
    const lines: string[] = [`# Iteration ${iteration}`];
    if (innerRetriesUsed !== undefined && maxInnerRetries !== undefined && maxInnerRetries > 0) {
      lines.push(`Gate re-evaluations used: ${innerRetriesUsed}/${maxInnerRetries}`);
    }
    // Include base stages (e.g. plan) so re-plan iterations have context on failures, and every stage the iteration
    // added after dispatch (scoped repairs): a new iteration retires all non-base stages, so state.stages holds only this one's.
    const allIds = [...(baseStageIds ?? []), ...dispatchedStageIds, ...Object.keys(state.stages)];
    const seen = new Set<string>();
    for (const sid of allIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const ss = state.stages[sid];
      if (!ss) continue;
      lines.push(`## ${sid} (${ss.status})`);
      lines.push(`Output: ${runDirPath}/stages/${sid}/output.md`);
      if (ss.error) lines.push(`Error: ${ss.error}`);
      if (ss.duration_ms !== undefined) lines.push(`Duration: ${Math.round(ss.duration_ms / 1000)}s`);
      // Include actual gate verdict if available
      const verdict = readGateEvaluation(projectDir, sid, runId);
      if (verdict) {
        lines.push(`Gate verdict: ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.reason ? ' — ' + verdict.reason : ''}`);
      }

    }
    const pendingScope = pendingScopePlanningInputs(runDirPath);
    if (pendingScope.length > 0) {
      lines.push('## Pending scope-negotiation planning input');
      for (const entry of pendingScope) {
        lines.push(`- ${entry.digest}: ${entry.stageKind} requested ${entry.requestedPaths.join(', ')}; ${entry.rejectionReason}`);
      }
    }
    lines.push('');
    const content = lines.join('\n');
    if (existsSync(logPath)) {
      const existing = readFileSync(logPath, 'utf-8');
      writeFileSync(logPath, existing + '\n' + content, 'utf-8');
    } else {
      writeFileSync(logPath, content, 'utf-8');
    }
  }

  function writeCampaignEntry(projectDir: string, state: StoreState): void {
    const campaignStorageKey = resolveCampaignStorageKey(state);
    if (!campaignStorageKey) return;
    const campaignsDir = storeCampaignsRoot();
    mkdirSync(campaignsDir, { recursive: true });
    const filePath = join(campaignsDir, `${campaignStorageKey}.jsonl`);
    const runPath = runDir(projectDir, state.runId);
    const phase = findCampaignPhaseMetadata(projectDir, state);
    if (!phase) return;
    let gatesPassed = 0;
    let gatesTotal = 0;
    try {
      const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
      for (const f of files) {
        try {
          const v = readGateEvaluation(projectDir, f.slice('verdict_'.length, -'.json'.length), state.runId);
          if (v && typeof v.pass === 'boolean') { gatesTotal++; if (v.pass) gatesPassed++; }
        } catch { /* skip */ }
      }
    } catch { /* no verdicts */ }
    const entry: Record<string, unknown> = {
      seq: state.campaignSeq ?? 1,
      runId: state.runId,
      iteration: state.currentIteration ?? 1,
      gate: phase.gate,
      pass: phase.pass,
      gates: `${gatesPassed}/${gatesTotal}`,
      status: state.status,
      timestamp: new Date().toISOString(),
      campaignId: canonicalCampaignId(state.campaignId ?? state.campaignName ?? campaignStorageKey, projectDir)
        ?? campaignStorageKey,
      campaignStorageKey,
      campaignName: state.campaignName,
      projectIdentity: projectPersistenceIdentity(projectDir),
    };
    const terminalStudyComplete = readTerminalStudyCompletionEvidence(projectDir, state.runId, phase.gate);
    if (terminalStudyComplete && phase.pass) {
      entry.pass = true;
      entry.gates = '1/1';
      entry.workflowSatisfied = true;
      entry.terminalStudyComplete = true;
      entry.modelPass = false;
      entry.modelSuccess = false;
      entry.outcome = 'study_complete_without_model_success';
    }
    if (phase?.phase) entry.phase = phase.phase;
    if (typeof phase?.phaseComplete === 'boolean') entry.phaseComplete = phase.phaseComplete;
    if (phase?.nextPhase) entry.nextPhase = phase.nextPhase;
    if (phase?.outcome) entry.outcome = phase.outcome;
    if (phase?.artifactSummary) entry.artifactSummary = phase.artifactSummary;
    if (phase?.reason) entry.reason = phase.reason;
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  function writeCampaignEntryUnlessPaused(projectDir: string, state: StoreState): void {
    if (isPausedRunStatus(state.status)) return;
    writeCampaignEntry(projectDir, state);
  }

  return { appendIterationLog, writeCampaignEntry, writeCampaignEntryUnlessPaused };
}
