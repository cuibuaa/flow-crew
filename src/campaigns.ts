import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreState } from './store.js';
import { homedir } from 'node:os';
import { readRunIndexRecords, recordToPartialState } from './run-index.js';

export interface CampaignHistoryEntry {
  seq: number;
  runId: string;
  iteration?: number;
  score?: number;
  metric?: string;
  gate?: string;
  pass: boolean;
  status?: string;
  timestamp: string;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  artifactSummary?: string;
  reason?: string;
}

export interface CampaignSummaryRecord {
  id: string;
  name: string;
  storageKey: string;
  runCount: number;
  bestScore: number | null;
  latestRun?: string;
  latestTimestamp?: string;
}

export interface CampaignSelectionInput {
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
}

export interface CampaignSelection {
  id: string;
  name: string;
  storageKey: string;
}

function runsRoot(_projectDir: string): string {
  return join(homedir(), '.fc', 'runs');
}

function campaignsRoot(projectDir: string): string {
  return join(projectDir, '.fc', 'campaigns');
}

export function cleanCampaignName(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  let trimmed = value.trim();
  let previous = '';
  while (trimmed && trimmed !== previous) {
    previous = trimmed;
    trimmed = trimmed.replace(/^(?:\.\.(?:[\\/]|$)|\.(?:[\\/]|$)|[\\/])+/g, '').trimStart();
    trimmed = trimmed.replace(/^new:/i, '').trimStart();
  }
  trimmed = trimmed.replace(/\s+/g, ' ');
  return trimmed || undefined;
}

export function canonicalCampaignStorageKey(value?: string): string | undefined {
  const cleaned = cleanCampaignName(value);
  if (!cleaned) return undefined;
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'campaign';
}

export const canonicalCampaignId = canonicalCampaignStorageKey;

export function resolveCampaignStorageKey(input: {
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
}): string | undefined {
  return canonicalCampaignStorageKey(
    input.campaignStorageKey ?? input.campaignId ?? input.campaignName,
  );
}

function readRunStates(projectDir: string): StoreState[] {
  const indexed = readRunIndexRecords(projectDir);
  if (indexed) return indexed.map(recordToPartialState);

  let runIds: string[];
  try {
    runIds = readdirSync(runsRoot(projectDir));
  } catch { /* non-critical */
    return [];
  }

  const states: StoreState[] = [];
  for (const runId of runIds) {
    try {
      const raw = readFileSync(join(runsRoot(projectDir), runId, 'run.json'), 'utf-8');
      states.push(JSON.parse(raw) as StoreState);
    } catch { /* non-critical */
      // Incomplete or corrupt run directories should not hide valid campaigns.
    }
  }
  return states;
}

function normalizeRunCampaign(state: StoreState): CampaignSelection | undefined {
  const storageKey = resolveCampaignStorageKey({
    campaignId: state.campaignId,
    campaignStorageKey: state.campaignStorageKey,
    campaignName: state.campaignName,
  });
  if (!storageKey) return undefined;
  const id = canonicalCampaignId(state.campaignId ?? state.campaignName ?? storageKey) ?? storageKey;
  return {
    id,
    name: cleanCampaignName(state.campaignName ?? state.campaignId) ?? id,
    storageKey,
  };
}

function normalizeEntryCampaign(fileStem: string, entry: Partial<CampaignHistoryEntry>): CampaignSelection | undefined {
  const storageKey = resolveCampaignStorageKey({
    campaignId: entry.campaignId,
    campaignStorageKey: entry.campaignStorageKey,
    campaignName: entry.campaignName ?? fileStem,
  });
  if (!storageKey) return undefined;
  const id = canonicalCampaignId(entry.campaignId ?? entry.campaignName ?? fileStem ?? storageKey) ?? storageKey;
  return {
    id,
    name: cleanCampaignName(entry.campaignName ?? fileStem ?? entry.campaignId) ?? id,
    storageKey,
  };
}

export function readCampaignEntries(projectDir: string, campaignId: string): CampaignHistoryEntry[] {
  const targetStorageKey = resolveCampaignStorageKey({ campaignId });
  if (!targetStorageKey) return [];
  const byRunIteration = new Map<string, CampaignHistoryEntry>();
  try {
    for (const file of readdirSync(campaignsRoot(projectDir)).filter((name) => name.endsWith('.jsonl'))) {
      const fileStem = file.replace(/\.jsonl$/, '');
      const rawLines = readFileSync(join(campaignsRoot(projectDir), file), 'utf-8').split('\n').filter(Boolean);
      for (const line of rawLines) {
        try {
          const parsed = JSON.parse(line) as Partial<CampaignHistoryEntry>;
          const ref = normalizeEntryCampaign(fileStem, parsed);
          if (!ref || ref.storageKey !== targetStorageKey) continue;
          if (typeof parsed.seq !== 'number' || typeof parsed.runId !== 'string') continue;
          const hasScore = typeof parsed.score === 'number'
            && Number.isFinite(parsed.score)
            && typeof parsed.metric === 'string';
          const hasPhase = typeof parsed.phase === 'string'
            || typeof parsed.phaseComplete === 'boolean'
            || typeof parsed.nextPhase === 'string'
            || typeof parsed.outcome === 'string';
          if (!hasScore && !hasPhase) continue;
          const normalized: CampaignHistoryEntry = {
            seq: parsed.seq,
            runId: parsed.runId,
            iteration: typeof parsed.iteration === 'number' ? parsed.iteration : undefined,
            score: hasScore ? parsed.score : undefined,
            metric: hasScore ? parsed.metric : undefined,
            gate: typeof parsed.gate === 'string' ? parsed.gate : undefined,
            pass: parsed.pass === true,
            status: typeof parsed.status === 'string' ? parsed.status : undefined,
            timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date(0).toISOString(),
            campaignId: ref.id,
            campaignStorageKey: ref.storageKey,
            campaignName: ref.name,
            phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
            phaseComplete: typeof parsed.phaseComplete === 'boolean' ? parsed.phaseComplete : undefined,
            nextPhase: typeof parsed.nextPhase === 'string' ? parsed.nextPhase : undefined,
            outcome: typeof parsed.outcome === 'string' ? parsed.outcome : undefined,
            artifactSummary: typeof parsed.artifactSummary === 'string' ? parsed.artifactSummary : undefined,
            reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          };
          const key = `${normalized.runId}::${normalized.iteration ?? 1}::${hasScore ? 'score' : 'phase'}`;
          const previous = byRunIteration.get(key);
          if (!previous || normalized.timestamp >= previous.timestamp) {
            byRunIteration.set(key, normalized);
          }
        } catch { /* non-critical */
          // Ignore malformed lines.
        }
      }
    }
  } catch { /* non-critical */
    return [];
  }
  const entries = [...byRunIteration.values()];
  entries.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const iterDiff = (a.iteration ?? 0) - (b.iteration ?? 0);
    if (iterDiff !== 0) return iterDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });
  return entries;
}

export function listCampaigns(projectDir: string): CampaignSummaryRecord[] {
  const summaries = new Map<string, CampaignSummaryRecord & { runIds: Set<string> }>();
  const upsert = (campaign: CampaignSelection, runId?: string, timestamp?: string, score?: number) => {
    const existing = summaries.get(campaign.storageKey) ?? {
      id: campaign.id,
      name: campaign.name,
      storageKey: campaign.storageKey,
      runCount: 0,
      bestScore: null,
      latestRun: undefined,
      latestTimestamp: undefined,
      runIds: new Set<string>(),
    };
    existing.name = campaign.name || existing.name;
    if (typeof runId === 'string') existing.runIds.add(runId);
    existing.runCount = existing.runIds.size;
    if (typeof score === 'number' && (existing.bestScore == null || score > existing.bestScore)) {
      existing.bestScore = score;
    }
    if (timestamp && (!existing.latestTimestamp || timestamp > existing.latestTimestamp)) {
      existing.latestTimestamp = timestamp;
      existing.latestRun = runId ?? existing.latestRun;
    }
    summaries.set(campaign.storageKey, existing);
  };

  for (const state of readRunStates(projectDir)) {
    const campaign = normalizeRunCampaign(state);
    if (!campaign) continue;
    upsert(campaign, state.runId, state.startedAt);
  }

  try {
    for (const file of readdirSync(campaignsRoot(projectDir)).filter((name) => name.endsWith('.jsonl'))) {
      const fileStem = file.replace(/\.jsonl$/, '');
      const lines = readFileSync(join(campaignsRoot(projectDir), file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Partial<CampaignHistoryEntry>;
          const campaign = normalizeEntryCampaign(fileStem, parsed);
          if (!campaign || typeof parsed.runId !== 'string') continue;
          upsert(campaign, parsed.runId, typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined, typeof parsed.score === 'number' ? parsed.score : undefined);
        } catch { /* non-critical */
          // Ignore malformed lines.
        }
      }
    }
  } catch { /* non-critical */
    // No campaign history yet.
  }

  return [...summaries.values()]
    .map(({ runIds, ...summary }) => summary)
    .sort((a, b) => (b.latestTimestamp ?? '').localeCompare(a.latestTimestamp ?? ''));
}

export function resolveCampaignSelection(projectDir: string, input: CampaignSelectionInput): CampaignSelection | undefined {
  const requestedStorageKey = resolveCampaignStorageKey(input);
  const requestedId = canonicalCampaignId(input.campaignId ?? input.campaignName ?? requestedStorageKey);
  const requestedName = cleanCampaignName(input.campaignName);
  const existing = requestedStorageKey
    ? listCampaigns(projectDir).find((campaign) => campaign.storageKey === requestedStorageKey)
    : undefined;
  const storageKey = requestedStorageKey ?? existing?.storageKey;
  const id = requestedId ?? existing?.id ?? canonicalCampaignId(requestedName);
  if (!storageKey || !id) return undefined;
  return {
    id,
    name: requestedName ?? existing?.name ?? cleanCampaignName(input.campaignId) ?? id,
    storageKey,
  };
}

export function nextCampaignSeq(projectDir: string, campaignId: string): number {
  const targetStorageKey = resolveCampaignStorageKey({ campaignId });
  if (!targetStorageKey) return 1;
  let maxSeq = 0;

  for (const state of readRunStates(projectDir)) {
    const campaign = normalizeRunCampaign(state);
    if (!campaign || campaign.storageKey !== targetStorageKey) continue;
    if (typeof state.campaignSeq === 'number') maxSeq = Math.max(maxSeq, state.campaignSeq);
  }

  for (const entry of readCampaignEntries(projectDir, targetStorageKey)) {
    maxSeq = Math.max(maxSeq, entry.seq);
  }

  return maxSeq + 1;
}

export function collapseEntriesForHealth(entries: CampaignHistoryEntry[]): CampaignHistoryEntry[] {
  const bySeq = new Map<number, CampaignHistoryEntry>();
  for (const entry of entries) {
    if (typeof entry.score !== 'number' || typeof entry.metric !== 'string') continue;
    const previous = bySeq.get(entry.seq);
    if (!previous) {
      bySeq.set(entry.seq, entry);
      continue;
    }
    const prevIteration = previous.iteration ?? 0;
    const nextIteration = entry.iteration ?? 0;
    if (nextIteration > prevIteration || (nextIteration === prevIteration && entry.timestamp > previous.timestamp)) {
      bySeq.set(entry.seq, entry);
    }
  }
  return [...bySeq.values()].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

export interface CampaignPhaseProgress {
  entries: CampaignHistoryEntry[];
  completedPhases: string[];
  currentPhase?: string;
  latest?: CampaignHistoryEntry;
}

export function summarizeCampaignPhaseProgress(entries: CampaignHistoryEntry[]): CampaignPhaseProgress {
  const phaseEntries = entries
    .filter((entry) => entry.phase || entry.nextPhase || entry.outcome || typeof entry.phaseComplete === 'boolean')
    .sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      const iterDiff = (a.iteration ?? 0) - (b.iteration ?? 0);
      if (iterDiff !== 0) return iterDiff;
      return a.timestamp.localeCompare(b.timestamp);
    });
  const completedPhases = [...new Set(
    phaseEntries
      .filter((entry) => entry.phaseComplete === true && entry.phase)
      .map((entry) => entry.phase as string),
  )];
  const latest = phaseEntries.at(-1);
  const currentPhase = latest?.phaseComplete === true
    ? latest.nextPhase
    : latest?.phase ?? latest?.nextPhase;
  return {
    entries: phaseEntries,
    completedPhases,
    currentPhase,
    latest,
  };
}

export function campaignExists(projectDir: string, campaignId: string): boolean {
  const storageKey = resolveCampaignStorageKey({ campaignId });
  if (!storageKey) return false;
  if (listCampaigns(projectDir).some((campaign) => campaign.storageKey === storageKey)) return true;
  return existsSync(join(campaignsRoot(projectDir), `${storageKey}.jsonl`));
}
