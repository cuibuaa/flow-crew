import {
  collapseEntriesForHealth,
  summarizeCampaignPhaseProgress,
  type CampaignHistoryEntry,
} from './campaigns.js';
import { isTerminalRunStatus } from './store.js';

export const CAMPAIGN_CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CampaignContextSelection {
  /** Fresh, non-terminal entries after completed-phase details are removed. */
  entries: CampaignHistoryEntry[];
  scoredEntries: CampaignHistoryEntry[];
  phaseEntries: CampaignHistoryEntry[];
  latestPhaseEntry?: CampaignHistoryEntry;
  recommendedPhase?: string;
  /** Runs whose still-relevant score/phase detail may contribute a summary path. */
  summaryRunIds: string[];
}

export interface CampaignPromptAlert {
  type: string;
  message: string;
}

function compareEntries(a: CampaignHistoryEntry, b: CampaignHistoryEntry): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  const iterationDifference = (a.iteration ?? 0) - (b.iteration ?? 0);
  if (iterationDifference !== 0) return iterationDifference;
  return a.timestamp.localeCompare(b.timestamp);
}

function cleanPhase(value: string | undefined): string | undefined {
  const phase = value?.trim();
  return phase || undefined;
}

function isFresh(entry: CampaignHistoryEntry, nowMs: number): boolean {
  const timestampMs = Date.parse(entry.timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= nowMs - CAMPAIGN_CONTEXT_MAX_AGE_MS;
}

function isPhaseEntry(entry: CampaignHistoryEntry): boolean {
  return Boolean(entry.phase || entry.nextPhase || entry.outcome || typeof entry.phaseComplete === 'boolean');
}

/**
 * Select the campaign narrative that is still relevant to a new planner turn.
 *
 * This deliberately does not touch the compact campaign ledger: tried directions
 * and KG dead ends have a separate, durable retention policy.
 */
export function selectRelevantCampaignContext(
  entries: CampaignHistoryEntry[],
  nowMs: number = Date.now(),
): CampaignContextSelection {
  const terminalRunIds = new Set(
    entries
      .filter((entry) => typeof entry.status === 'string' && isTerminalRunStatus(entry.status))
      .map((entry) => entry.runId),
  );
  const candidates = entries
    .filter((entry) => !terminalRunIds.has(entry.runId) && isFresh(entry, nowMs))
    .sort(compareEntries);

  const completions = candidates.filter((entry) => entry.phaseComplete === true);
  const completedPhases = new Set(
    completions
      .map((entry) => cleanPhase(entry.phase))
      .filter((phase): phase is string => phase !== undefined),
  );
  const activeEntries = candidates.filter((entry) => {
    if (entry.phaseComplete === true) return false;
    const phase = cleanPhase(entry.phase);
    return !phase || !completedPhases.has(phase);
  });

  const scoredEntries = collapseEntriesForHealth(activeEntries);
  const phaseEntries = activeEntries.filter(isPhaseEntry).sort(compareEntries);
  const phaseProgress = summarizeCampaignPhaseProgress(phaseEntries);
  const latestCompletion = completions[completions.length - 1];
  // A completed chain is governed by its latest completion. Falling back to an
  // older non-empty nextPhase would resurrect a handoff that a later phase closed.
  const latestHandoff = cleanPhase(latestCompletion?.nextPhase);
  const recommendedPhase = cleanPhase(phaseProgress.currentPhase) ?? latestHandoff;
  const summaryRunIds = [...new Set(
    [...scoredEntries, ...phaseEntries].map((entry) => entry.runId),
  )];

  return {
    entries: activeEntries,
    scoredEntries,
    phaseEntries,
    latestPhaseEntry: phaseProgress.latest,
    recommendedPhase,
    summaryRunIds,
  };
}

/** Format a verbose campaign block, returning an empty string instead of an empty shell. */
export function formatCampaignContextBlock(options: {
  campaignLabel: string;
  selection: CampaignContextSelection;
  summaryPaths?: string[];
  alert?: CampaignPromptAlert | null;
}): string {
  const { selection, alert } = options;
  const summaryPaths = [...new Set((options.summaryPaths ?? []).filter(Boolean))];
  const hasPhaseProgress = selection.phaseEntries.length > 0 || Boolean(selection.recommendedPhase);
  if (selection.scoredEntries.length === 0 && !hasPhaseProgress && summaryPaths.length === 0 && !alert) {
    return '';
  }

  let context = `=== CAMPAIGN: ${options.campaignLabel} ===\n`;
  if (selection.scoredEntries.length > 0) {
    const rows = selection.scoredEntries
      .map((entry) => `| ${entry.seq} | ${entry.iteration ?? 1} | ${entry.score ?? '-'} | ${entry.metric ?? '-'} | ${entry.gate ?? '-'} | ${entry.pass ? 'pass' : 'fail'} |`)
      .join('\n');
    const best = Math.max(...selection.scoredEntries.map((entry) => entry.score as number));
    context += `| # | Iteration | Score | Metric | Gate | Status |\n|---|-----------|-------|--------|------|--------|\n${rows}\n\nBest ever: ${best}\n`;
  }
  if (hasPhaseProgress) {
    context += '\nPhase progress:\n';
    context += `- Current recommended phase: ${selection.recommendedPhase ?? 'not specified'}\n`;
    const latest = selection.latestPhaseEntry;
    if (latest) {
      context += `- Latest phase event: seq ${latest.seq}, iteration ${latest.iteration ?? 1}, phase ${latest.phase ?? '-'}, phaseComplete ${latest.phaseComplete === true ? 'true' : 'false'}, nextPhase ${latest.nextPhase ?? '-'}, outcome ${latest.outcome ?? '-'}\n`;
      if (latest.artifactSummary) context += `- Latest artifact summary: ${latest.artifactSummary}\n`;
      if (latest.reason) context += `- Latest reason: ${latest.reason}\n`;
    }
    context += 'Planner rule: for multi-phase tasks, dispatch only the current recommended phase unless the task explicitly asks to restart from phase 0. Do not pack all future phases into one dispatch.\n';
  }
  if (summaryPaths.length > 0) {
    context += `\nPrevious run summaries:\n${summaryPaths.map((path) => `- ${path}`).join('\n')}\n`;
  }
  if (alert) {
    context += `\n⚠️ CAMPAIGN ALERT: ${alert.type} — ${alert.message}\nDO NOT retry approaches from failed runs. Propose a fundamentally different approach.\n`;
  }
  return context + '=== END CAMPAIGN ===\n\n';
}
