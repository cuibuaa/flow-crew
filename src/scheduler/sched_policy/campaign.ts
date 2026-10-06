/** Campaign metric/phase readers, health policy and iteration/campaign output; receives gate and scope-planning readers. */
import { type StoreState, isPausedRunStatus, requireRunArtifactDirectory, runDir, campaignsRoot as storeCampaignsRoot, stageDir } from '../../store.js';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalCampaignId, resolveCampaignStorageKey, collapseEntriesForHealth } from '../../campaigns.js';
import { projectPersistenceIdentity } from '../../project-identity.js';
import { type GateMetricLookup, type CampaignMetric, type CampaignPhaseMetadata } from '../sched_admission/configuration.js';

export interface CampaignWriterServices {
  readGateVerdict: typeof import('../../scheduler.js').readGateVerdict;
  readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null;
  pendingScopePlanningInputs(runDirPath: string): readonly { digest: string; stageKind: string; requestedPaths: string[]; rejectionReason: string }[];
}

export const CAMPAIGN_PHASE_COMPLETE_SENTINEL = 'complete';

function parseGateMetric(projectDir: string, state: StoreState, gateId: string): GateMetricLookup {
  const metricPath = join(stageDir(projectDir, state.runId, gateId), 'metric.json');
  if (!existsSync(metricPath)) return { found: false, metric: null };
  try {
    const artifact = JSON.parse(readFileSync(metricPath, 'utf-8'));
    if (artifact?.hasMetric !== true) return { found: true, metric: null };
    if (typeof artifact.value !== 'number' || !Number.isFinite(artifact.value)) return { found: true, metric: null };
    return {
      found: true,
      metric: {
        score: artifact.value,
        metric: typeof artifact.metric === 'string' ? artifact.metric : '',
        gate: gateId,
        pass: artifact.pass === true,
        threshold: typeof artifact.threshold === 'number' && Number.isFinite(artifact.threshold) ? artifact.threshold : undefined,
      },
    };
  } catch { /* non-critical */
    return { found: true, metric: null };
  }
}

function parseLegacyVerdictMetric(projectDir: string, state: StoreState, gateId: string): CampaignMetric | null {
  const verdictPath = join(runDir(projectDir, state.runId), `verdict_${gateId}.json`);
  try {
    const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
    const value = typeof verdict.score === 'number' && Number.isFinite(verdict.score)
      ? verdict.score
      : typeof verdict.value === 'number' && Number.isFinite(verdict.value)
        ? verdict.value
        : undefined;
    if (value === undefined) return null;
    return {
      score: value,
      metric: typeof verdict.metric === 'string' ? verdict.metric : '',
      gate: gateId,
      pass: verdict.pass === true,
      threshold: typeof verdict.threshold === 'number' && Number.isFinite(verdict.threshold) ? verdict.threshold : undefined,
    };
  } catch { /* non-critical */
    return null;
  }
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
  if (!hasPhaseMetadata) return null;
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
  const paths = [
    join(stageDir(projectDir, state.runId, gateId), 'metric.json'),
    join(runDir(projectDir, state.runId), `verdict_${gateId}.json`),
  ];
  for (const artifactPath of paths) {
    try {
      const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      const metadata = phaseMetadataFromArtifact(parsed, gateId);
      if (metadata) return metadata;
    } catch { /* non-critical */
      // Missing or malformed artifacts are ignored for phase tracking.
    }
  }
  return null;
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
  try {
    const stagesPath = join(runPath, 'stages');
    for (const stageId of readdirSync(stagesPath)) {
      if (existsSync(join(stagesPath, stageId, 'metric.json'))) ids.add(stageId);
    }
  } catch { /* non-critical */
    // No stage metrics yet.
  }
  return [...ids];
}

export function findCampaignMetric(projectDir: string, state: StoreState): CampaignMetric | null {
  let best: CampaignMetric | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metricLookup = parseGateMetric(projectDir, state, gateId);
    const metric = metricLookup.found ? metricLookup.metric : parseLegacyVerdictMetric(projectDir, state, gateId);
    if (metric) best = metric;
  }
  return best;
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
  type: 'regression' | 'plateau' | 'repeated_failure';
  action: 'inject_researcher';
  message: string;
}

export interface CampaignEntry {
  seq: number;
  runId: string;
  iteration?: number;
  score?: number;
  metric?: string;
  higherIsBetter?: boolean;
  gate?: string;
  pass: boolean;
  timestamp: string;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  workflowSatisfied?: boolean;
  terminalStudyComplete?: boolean;
  modelSuccess?: boolean;
}

type ScoredCampaignEntry = CampaignEntry & { score: number; metric: string };

export function checkCampaignHealth(entries: CampaignEntry[], triggers?: { enabled?: boolean; regressionAfter?: number; plateauAfter?: number; plateauThreshold?: number; repeatedFailureAfter?: number }): CampaignAlert | null {
  if (triggers?.enabled === false) return null;
  if (entries.at(-1)?.terminalStudyComplete === true || entries.at(-1)?.workflowSatisfied === true) return null;
  const scoredEntries = entries.filter((entry): entry is ScoredCampaignEntry => typeof entry.score === 'number' && typeof entry.metric === 'string');
  const scoped = collapseEntriesForHealth(scoredEntries) as ScoredCampaignEntry[];
  if (scoped.length < 2) return null;
  const regAfter = triggers?.regressionAfter ?? 2;
  const platAfter = triggers?.plateauAfter ?? 3;
  const platThresh = triggers?.plateauThreshold ?? 5;
  const repAfter = triggers?.repeatedFailureAfter ?? 3;
  const latestMetric = scoped.at(-1)?.metric;
  const comparable = latestMetric ? scoped.filter((entry) => entry.metric === latestMetric) : scoped;

  // Consecutive regressions in the declared optimization direction. Historical
  // entries without the field retain the prior higher-is-better interpretation.
  let declines = 0;
  for (let i = comparable.length - 1; i > 0; i--) {
    const direction = comparable[i].higherIsBetter !== false;
    const priorDirection = comparable[i - 1].higherIsBetter !== false;
    if (direction !== priorDirection) break;
    if (direction ? comparable[i].score < comparable[i - 1].score : comparable[i].score > comparable[i - 1].score) declines++;
    else break;
  }
  if (declines >= regAfter) return { type: 'regression', action: 'inject_researcher', message: `${declines} consecutive score declines` };

  // Plateau (±threshold% for N+ entries)
  if (comparable.length >= platAfter) {
    const recent = comparable.slice(-platAfter);
    const avg = recent.reduce((s, e) => s + e.score, 0) / recent.length;
    if (!isFinite(avg)) {
      // All non-finite (Infinity/-Infinity/NaN): treat identical non-finite values as plateau
      if (recent.every(e => e.score === recent[0].score)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else if (avg === 0) {
      if (recent.every(e => Math.abs(e.score) <= platThresh / 100)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else {
      const allWithin = recent.every(e => Math.abs(e.score - avg) / Math.abs(avg) * 100 <= platThresh);
      if (allWithin) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    }
  }

  // Repeated same-gate failure
  if (scoped.length >= repAfter) {
    const recent = scoped.slice(-repAfter);
    if (recent.every(e => !e.pass) && recent.every(e => e.gate === recent[0].gate)) {
      return { type: 'repeated_failure', action: 'inject_researcher', message: `${repAfter} consecutive failures on gate ${recent[0].gate}` };
    }
  }

  return null;
}

export function createCampaignWriters(services: CampaignWriterServices) {
  const { readGateVerdict, readTerminalStudyCompletionEvidence, pendingScopePlanningInputs } = services;

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
    // Include base stages (e.g. plan) so re-plan iterations have context on failures
    const allIds = [...(baseStageIds ?? []), ...dispatchedStageIds];
    const seen = new Set<string>();
    for (const sid of allIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const ss = state.stages[sid];
      if (!ss) continue;
      lines.push(`## ${sid} (${ss.status})`);
      lines.push(`Output: ${runDirPath}/stages/${sid}/output.md`);
      lines.push(`Artifacts: ${ss.artifacts?.join(', ') || 'none'}`);
      if (ss.error) {
        const isAdapter = ss.error === 'adapter connection failed';
        lines.push(`Error: ${ss.error}${isAdapter ? ' (transient — not a code issue, retry may succeed)' : ''}`);
      }
      if (ss.duration_ms !== undefined) lines.push(`Duration: ${Math.round(ss.duration_ms / 1000)}s`);
      // Include actual gate verdict if available
      const verdict = readGateVerdict(projectDir, sid, runId);
      if (verdict) {
        lines.push(`Gate verdict: ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.reason ? ' — ' + verdict.reason : ''}`);
      }
      // Include campaign metric if available
      const metricLookup = parseGateMetric(projectDir, state, sid);
      if (metricLookup.metric) {
        const m = metricLookup.metric;
        lines.push(`Metric: ${m.metric} = ${m.score}${m.threshold !== undefined ? ` (threshold: ${m.threshold})` : ''}`);
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
    const campaignStorageKey = resolveCampaignStorageKey({
      campaignId: state.campaignId,
      campaignStorageKey: state.campaignStorageKey,
      campaignName: state.campaignName,
    });
    if (!campaignStorageKey) return;
    const campaignsDir = storeCampaignsRoot();
    mkdirSync(campaignsDir, { recursive: true });
    const filePath = join(campaignsDir, `${campaignStorageKey}.jsonl`);
    const runPath = runDir(projectDir, state.runId);
    const metric = findCampaignMetric(projectDir, state);
    const phase = findCampaignPhaseMetadata(projectDir, state);
    if (!metric && !phase) return;
    let gatesPassed = 0;
    let gatesTotal = 0;
    try {
      const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
      for (const f of files) {
        try {
          const v = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
          if (typeof v.pass === 'boolean') { gatesTotal++; if (v.pass) gatesPassed++; }
        } catch { /* skip */ }
      }
    } catch { /* no verdicts */ }
    const entry: Record<string, unknown> = {
      seq: state.campaignSeq ?? 1,
      runId: state.runId,
      iteration: state.currentIteration ?? 1,
      gate: metric?.gate ?? phase?.gate ?? 'campaign_phase',
      pass: metric?.pass ?? phase?.pass ?? false,
      gates: `${gatesPassed}/${gatesTotal}`,
      status: state.status,
      timestamp: new Date().toISOString(),
      campaignId: canonicalCampaignId(state.campaignId ?? state.campaignName ?? campaignStorageKey)
        ?? campaignStorageKey,
      campaignStorageKey,
      campaignName: state.campaignName,
      projectIdentity: projectPersistenceIdentity(projectDir),
    };
    const terminalStudyComplete = metric ? readTerminalStudyCompletionEvidence(projectDir, state.runId, metric.gate) : null;
    if (terminalStudyComplete) {
      entry.pass = true;
      entry.status = 'complete';
      entry.gates = '1/1';
      entry.workflowSatisfied = true;
      entry.terminalStudyComplete = true;
      entry.modelPass = false;
      entry.modelSuccess = false;
      entry.outcome = 'study_complete_without_model_success';
    }
    if (metric) {
      entry.score = metric.score;
      entry.metric = metric.metric;
      entry.threshold = metric.threshold;
      entry.higherIsBetter = state.research?.higherIsBetter !== false;
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
