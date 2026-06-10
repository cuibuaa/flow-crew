import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageStatus } from './store.js';
import { atomicWrite, runDir } from './store.js';

export type RunEventType =
  | 'stage_complete'
  | 'stage_failed'
  | 'stage_skipped'
  | 'verdict_written'
  | 'attempt_results_updated'
  | 'iteration_completed'
  | 'run_completed'
  | 'campaign_alert'
  | 'research_injected'
  | 'supervisor_replan'
  | 'attempt_summary_refresh_requested';

export interface RunEvent {
  type: RunEventType;
  runId: string;
  timestamp: string;
  iteration?: number;
  stageId?: string;
  status?: StageStatus['status'];
  artifacts?: string[];
  detail?: string;
}

export interface AttemptSummaryRefreshState {
  refreshVersion: number;
  pending: boolean;
  requestedAt?: string;
  scheduledAt?: string;
  reasons: string[];
  sourceEventTypes: RunEventType[];
}

const DEFAULT_DEBOUNCE_MS = 250;
const debounceTimers = new Map<string, NodeJS.Timeout>();

function eventsPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'events.jsonl');
}

function refreshStatePath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'attempt_summary_refresh.json');
}

function refreshTimerKey(projectDir: string, runId: string): string {
  return `${projectDir}::${runId}`;
}

function inferSummaryRefreshReasons(event: RunEvent): string[] {
  const reasons = new Set<string>();

  switch (event.type) {
    case 'stage_complete':
    case 'stage_failed':
    case 'stage_skipped':
      reasons.add(event.type);
      break;
    case 'verdict_written':
    case 'attempt_results_updated':
    case 'iteration_completed':
    case 'run_completed':
      reasons.add(event.type);
      break;
    default:
      break;
  }

  return [...reasons];
}

function readRefreshState(projectDir: string, runId: string): AttemptSummaryRefreshState {
  try {
    return JSON.parse(readFileSync(refreshStatePath(projectDir, runId), 'utf-8')) as AttemptSummaryRefreshState;
  } catch { /* non-critical */
    return {
      refreshVersion: 0,
      pending: false,
      reasons: [],
      sourceEventTypes: [],
    };
  }
}

function writeRefreshState(projectDir: string, runId: string, state: AttemptSummaryRefreshState): void {
  const dir = runDir(projectDir, runId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(refreshStatePath(projectDir, runId), JSON.stringify(state, null, 2));
}

export function readAttemptSummaryRefreshState(
  projectDir: string,
  runId: string,
): AttemptSummaryRefreshState | null {
  if (!existsSync(refreshStatePath(projectDir, runId))) return null;
  return readRefreshState(projectDir, runId);
}

export function appendRunEvent(projectDir: string, runId: string, event: RunEvent): void {
  const dir = runDir(projectDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(eventsPath(projectDir, runId), JSON.stringify(event) + '\n', 'utf-8');
}

export function readRunEvents(projectDir: string, runId: string): RunEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(projectDir, runId), 'utf-8');
  } catch { /* no events file yet */
    return [];
  }
  // Parse per line, tolerating a single corrupt/truncated row (an append-only file
  // can be torn by a crash mid-write). Previously one bad line threw and dropped
  // the ENTIRE event history — inconsistent with every other jsonl reader here.
  const out: RunEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as RunEvent); } catch { /* skip bad row */ }
  }
  return out;
}

export function requestAttemptSummaryRefresh(
  projectDir: string,
  runId: string,
  sourceEvents: RunEvent[],
  options?: { debounceMs?: number },
): void {
  if (sourceEvents.length === 0) return;
  const relevantSourceEvents = sourceEvents.filter((event) => inferSummaryRefreshReasons(event).length > 0);
  if (relevantSourceEvents.length === 0) return;

  const key = refreshTimerKey(projectDir, runId);
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = new Date().toISOString();
  const existing = readRefreshState(projectDir, runId);
  const reasons = new Set(existing.reasons);
  const eventTypes = new Set(existing.sourceEventTypes);

  for (const event of relevantSourceEvents) {
    eventTypes.add(event.type);
    for (const reason of inferSummaryRefreshReasons(event)) reasons.add(reason);
  }

  writeRefreshState(projectDir, runId, {
    ...existing,
    pending: true,
    requestedAt: now,
    reasons: [...reasons],
    sourceEventTypes: [...eventTypes],
  });

  const activeTimer = debounceTimers.get(key);
  if (activeTimer) clearTimeout(activeTimer);

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    const latest = readRefreshState(projectDir, runId);
    const scheduledAt = new Date().toISOString();
    const nextState: AttemptSummaryRefreshState = {
      ...latest,
      refreshVersion: latest.refreshVersion + 1,
      pending: false,
      scheduledAt,
    };
    writeRefreshState(projectDir, runId, nextState);
    appendRunEvent(projectDir, runId, {
      type: 'attempt_summary_refresh_requested',
      runId,
      timestamp: scheduledAt,
      detail: nextState.reasons.join(', '),
    });
  }, debounceMs);

  debounceTimers.set(key, timer);
}

function buildArtifactEvents(runId: string, event: RunEvent): RunEvent[] {
  const artifactEvents: RunEvent[] = [];
  const artifacts = event.artifacts ?? [];
  const verdictArtifacts = artifacts.filter((artifact) => /(^|\/)verdict(_|\.|\/)/i.test(artifact));
  if (verdictArtifacts.length > 0) {
    artifactEvents.push({
      type: 'verdict_written',
      runId,
      timestamp: event.timestamp,
      iteration: event.iteration,
      stageId: event.stageId,
      artifacts: verdictArtifacts,
    });
  }
  const resultArtifacts = artifacts.filter((artifact) =>
    /(^|\/)(attempt|attempts|result|results|metrics|score|table)/i.test(artifact),
  );
  if (resultArtifacts.length > 0) {
    artifactEvents.push({
      type: 'attempt_results_updated',
      runId,
      timestamp: event.timestamp,
      iteration: event.iteration,
      stageId: event.stageId,
      artifacts: resultArtifacts,
    });
  }
  return artifactEvents;
}

export function recordStageOutcome(
  projectDir: string,
  runId: string,
  stageId: string,
  iteration: number | undefined,
  status: StageStatus,
  options?: { debounceMs?: number },
): void {
  if (
    status.status !== 'complete' &&
    status.status !== 'failed' &&
    status.status !== 'skipped'
  ) {
    return;
  }

  const timestamp = status.completedAt ?? new Date().toISOString();
  const stageEvent: RunEvent = {
    type: status.status === 'complete'
      ? 'stage_complete'
      : status.status === 'failed'
        ? 'stage_failed'
        : 'stage_skipped',
    runId,
    timestamp,
    iteration,
    stageId,
    status: status.status,
    artifacts: status.artifacts,
  };

  const events = [stageEvent, ...buildArtifactEvents(runId, stageEvent)];
  for (const event of events) appendRunEvent(projectDir, runId, event);
  requestAttemptSummaryRefresh(projectDir, runId, events, options);
}

export function recordRunEvent(
  projectDir: string,
  runId: string,
  event: RunEvent,
  options?: { debounceMs?: number },
): void {
  appendRunEvent(projectDir, runId, event);
  requestAttemptSummaryRefresh(projectDir, runId, [event], options);
}

export function clearAttemptSummaryRefreshDebounce(projectDir?: string, runId?: string): void {
  if (projectDir && runId) {
    const key = refreshTimerKey(projectDir, runId);
    const timer = debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
    return;
  }

  for (const [key, timer] of debounceTimers) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
}
