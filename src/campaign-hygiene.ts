import type { CampaignHistoryEntry } from './campaigns.js';
import { resolveRunStatus, RUN_STATUS, type RunStatus } from './store.js';

export const CAMPAIGN_HYGIENE_RECENT_LIMIT = 10;
export const CAMPAIGN_CONTEXT_SKIP_THRESHOLD = 3;

const ADVERSE_END_STATUS = {
  [RUN_STATUS.PENDING]: false,
  [RUN_STATUS.RUNNING]: false,
  [RUN_STATUS.PARKED]: false,
  [RUN_STATUS.COMPLETE]: false,
  [RUN_STATUS.FAILED]: true,
  [RUN_STATUS.AWAITING_APPROVAL]: false,
  [RUN_STATUS.SHIPPED]: false,
  [RUN_STATUS.CEILING_HIT]: true,
  [RUN_STATUS.ESCALATED]: true,
  [RUN_STATUS.REALITY_GATE_FAILED]: true,
  [RUN_STATUS.PHASE_COMPLETE]: false,
  [RUN_STATUS.STOPPED]: true,
  [RUN_STATUS.INCOMPLETE]: true,
} as const satisfies Record<RunStatus, boolean>;

export interface CampaignHygieneDecision {
  totalEntries: number;
  totalEnded: number;
  recentEnded: number;
  recentAdverse: number;
  suggestContextSkip: boolean;
}

/** One pure decision shared by preflight reporting and launch defaults. */
export function assessCampaignHygiene(entries: readonly CampaignHistoryEntry[]): CampaignHygieneDecision {
  const ended = entries.filter((entry) => entry.kind === 'task_ended' && typeof entry.status === 'string');
  const recent = ended.slice(-CAMPAIGN_HYGIENE_RECENT_LIMIT);
  const recentAdverse = recent.filter((entry) => {
    const status = resolveRunStatus(entry.status);
    return status.kind === 'unknown' || ADVERSE_END_STATUS[status.status];
  }).length;
  return {
    totalEntries: entries.length,
    totalEnded: ended.length,
    recentEnded: recent.length,
    recentAdverse,
    suggestContextSkip: recentAdverse >= CAMPAIGN_CONTEXT_SKIP_THRESHOLD,
  };
}
