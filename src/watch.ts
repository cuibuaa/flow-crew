import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRunningRunStatus, runsRoot as globalRunsRoot } from './store.js';
import { terminalArtifactStatusMismatch } from './terminal-artifact-status.js';

export interface WatchState {
  initialized: boolean;
  activeConditionIds: ReadonlySet<string>;
}

export interface WatchPollDependencies {
  runsRoot?: string;
  readDirectory?: (path: string) => readonly string[];
  readText?: (path: string) => string;
  isProcessAlive?: (pid: number) => boolean;
  artifactMtimeMs?: (path: string) => number | undefined;
  nowMs?: () => number;
}

export interface WatchScanStats {
  entries: number;
  readableRuns: number;
  unreadableRuns: number;
  liveRuns: number;
  invalidVerdicts: number;
  archiveReadErrors: number;
  rootReadErrors: number;
  elapsedMs: number;
}

export interface WatchHeartbeat {
  kind: 'heartbeat';
  stats: WatchScanStats;
}

export interface WatchAttemptAlert {
  kind: 'stage_attempts';
  conditionId: string;
  runId: string;
  stageId: string;
  attempts: number;
}

export interface WatchGateAlert {
  kind: 'gate_not_converging';
  conditionId: string;
  runId: string;
  gateId: string;
  metric: string;
  previousScore: number;
  latestScore: number;
  threshold: number;
  rejections: number;
}

export interface WatchTerminalStatusAlert {
  kind: 'terminal_status_mismatch';
  conditionId: string;
  runId: string;
  lifecycleStatus: string;
  terminalStatus: string;
  terminalArtifact: string;
}

export type WatchAlert = WatchAttemptAlert | WatchGateAlert | WatchTerminalStatusAlert;

export interface WatchPollResult {
  state: WatchState;
  stats: WatchScanStats;
  heartbeat?: WatchHeartbeat;
  alerts: WatchAlert[];
}

interface ResolvedWatchPollDependencies {
  runsRoot: string;
  readDirectory: (path: string) => readonly string[];
  readText: (path: string) => string;
  isProcessAlive: (pid: number) => boolean;
  artifactMtimeMs?: (path: string) => number | undefined;
  nowMs: () => number;
}

interface JsonObject {
  [key: string]: unknown;
}

interface GateVerdictRecord {
  gateId: string;
  iteration: number;
  round: number;
  metric: string;
  score: number;
  threshold: number;
}

interface MutableDiagnostics {
  invalidVerdicts: number;
  archiveReadErrors: number;
}

const ITERATION_DIRECTORY = /^iteration_(\d+)$/;
const ROUND_DIRECTORY = /^round_(\d+)$/;
const REJECTED_VERDICT_FILE = /^rejected_verdict_(.+)\.json$/;

export function createWatchState(): WatchState {
  return { initialized: false, activeConditionIds: new Set<string>() };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function resolveDependencies(overrides: WatchPollDependencies): ResolvedWatchPollDependencies {
  return {
    runsRoot: overrides.runsRoot ?? globalRunsRoot(),
    readDirectory: overrides.readDirectory ?? ((path) => readdirSync(path)),
    readText: overrides.readText ?? ((path) => readFileSync(path, 'utf-8')),
    isProcessAlive: overrides.isProcessAlive ?? processIsAlive,
    artifactMtimeMs: overrides.artifactMtimeMs,
    nowMs: overrides.nowMs ?? Date.now,
  };
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parsePositiveInteger(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeEntryName(name: string): boolean {
  return name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\');
}

function conditionId(kind: string, ...parts: string[]): string {
  return JSON.stringify([kind, ...parts]);
}

function readDirectory(
  path: string,
  deps: ResolvedWatchPollDependencies,
  diagnostics: MutableDiagnostics,
): readonly string[] | undefined {
  try {
    return deps.readDirectory(path);
  } catch {
    diagnostics.archiveReadErrors += 1;
    return undefined;
  }
}

function readVerdict(
  path: string,
  gateId: string,
  iteration: number,
  round: number,
  deps: ResolvedWatchPollDependencies,
  diagnostics: MutableDiagnostics,
): GateVerdictRecord | undefined {
  let verdict: JsonObject | undefined;
  try {
    verdict = parseObject(deps.readText(path));
  } catch {
    verdict = undefined;
  }
  if (!verdict
    || typeof verdict.metric !== 'string'
    || verdict.metric.trim().length === 0
    || typeof verdict.score !== 'number'
    || !Number.isFinite(verdict.score)
    || typeof verdict.threshold !== 'number'
    || !Number.isFinite(verdict.threshold)) {
    diagnostics.invalidVerdicts += 1;
    return undefined;
  }
  return {
    gateId,
    iteration,
    round,
    metric: verdict.metric,
    score: verdict.score,
    threshold: verdict.threshold,
  };
}

function verdictsInRound(
  iteration: number,
  round: number,
  roundDir: string,
  deps: ResolvedWatchPollDependencies,
  diagnostics: MutableDiagnostics,
): GateVerdictRecord[] {
  const files = readDirectory(roundDir, deps, diagnostics);
  if (!files) return [];
  const records: GateVerdictRecord[] = [];
  for (const file of [...files].sort()) {
    if (!safeEntryName(file)) continue;
    const match = REJECTED_VERDICT_FILE.exec(file);
    if (!match) continue;
    const record = readVerdict(
      join(roundDir, file),
      match[1],
      iteration,
      round,
      deps,
      diagnostics,
    );
    if (record) records.push(record);
  }
  return records;
}

function collectGateVerdicts(
  runDir: string,
  deps: ResolvedWatchPollDependencies,
  diagnostics: MutableDiagnostics,
): GateVerdictRecord[] {
  const archiveRoot = join(runDir, 'gate_reevaluation');
  let topLevel: readonly string[];
  try {
    topLevel = deps.readDirectory(archiveRoot);
  } catch (error) {
    // Most runs never enter gate re-evaluation, so an absent archive is normal.
    if (!isMissingPathError(error)) diagnostics.archiveReadErrors += 1;
    return [];
  }

  const iterations = topLevel
    .map((name) => ({ name, match: safeEntryName(name) ? ITERATION_DIRECTORY.exec(name) : null }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({ name, iteration: Number(match[1]) }))
    .filter(({ iteration }) => Number.isSafeInteger(iteration) && iteration > 0)
    .sort((a, b) => a.iteration - b.iteration);

  const records: GateVerdictRecord[] = [];
  if (iterations.length > 0) {
    // Once the canonical iteration namespace exists, legacy round-only evidence is
    // stale by repository convention and must not be mixed into a judgement.
    for (const { name, iteration } of iterations) {
      const iterationDir = join(archiveRoot, name);
      const entries = readDirectory(iterationDir, deps, diagnostics);
      if (!entries) continue;
      const rounds = entries
        .map((entry) => ({ entry, match: safeEntryName(entry) ? ROUND_DIRECTORY.exec(entry) : null }))
        .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
        .map(({ entry, match }) => ({ entry, round: Number(match[1]) }))
        .filter(({ round }) => Number.isSafeInteger(round) && round > 0)
        .sort((a, b) => a.round - b.round);
      for (const { entry, round } of rounds) {
        records.push(...verdictsInRound(
          iteration,
          round,
          join(iterationDir, entry),
          deps,
          diagnostics,
        ));
      }
    }
    return records;
  }

  const legacyRounds = topLevel
    .map((entry) => ({ entry, match: safeEntryName(entry) ? ROUND_DIRECTORY.exec(entry) : null }))
    .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
    .map(({ entry, match }) => ({ entry, round: Number(match[1]) }))
    .filter(({ round }) => Number.isSafeInteger(round) && round > 0)
    .sort((a, b) => a.round - b.round);
  for (const { entry, round } of legacyRounds) {
    records.push(...verdictsInRound(
      0,
      round,
      join(archiveRoot, entry),
      deps,
      diagnostics,
    ));
  }
  return records;
}

function stageAttemptConditions(runId: string, state: JsonObject): WatchAttemptAlert[] {
  const stages = state.stages;
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return [];
  const alerts: WatchAttemptAlert[] = [];
  for (const [stageId, value] of Object.entries(stages)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const attempts = (value as JsonObject).attempts;
    if (!Array.isArray(attempts) || attempts.length < 3) continue;
    alerts.push({
      kind: 'stage_attempts',
      conditionId: conditionId('stage_attempts', runId, stageId),
      runId,
      stageId,
      attempts: attempts.length,
    });
  }
  return alerts;
}

function gateConditions(runId: string, records: GateVerdictRecord[]): WatchGateAlert[] {
  const byGate = new Map<string, GateVerdictRecord[]>();
  for (const record of records) {
    const previous = byGate.get(record.gateId) ?? [];
    previous.push(record);
    byGate.set(record.gateId, previous);
  }

  const alerts: WatchGateAlert[] = [];
  for (const [gateId, rows] of byGate) {
    rows.sort((a, b) => a.iteration - b.iteration || a.round - b.round);
    if (rows.length < 2) continue;
    const latest = rows.at(-1)!;
    const comparable = rows.filter((row) => (
      row.metric === latest.metric && row.threshold === latest.threshold
    ));
    if (comparable.length < 2) continue;
    const previous = comparable.at(-2)!;
    const previousDistance = Math.abs(previous.score - previous.threshold);
    const latestDistance = Math.abs(latest.score - latest.threshold);
    if (latestDistance < previousDistance) continue;
    alerts.push({
      kind: 'gate_not_converging',
      conditionId: conditionId('gate_not_converging', runId, gateId, latest.metric),
      runId,
      gateId,
      metric: latest.metric,
      previousScore: previous.score,
      latestScore: latest.score,
      threshold: latest.threshold,
      rejections: comparable.length,
    });
  }
  return alerts;
}

/**
 * Scan once and advance only the active-condition set. The function has no
 * write capability: injected readers, clock, and signal-0 probe make the state
 * transition deterministic in tests, while production performs one in-process
 * runs-root enumeration and never starts a per-run command.
 */
export function pollWatch(
  previousState: WatchState,
  overrides: WatchPollDependencies = {},
): WatchPollResult {
  const deps = resolveDependencies(overrides);
  const startedAt = deps.nowMs();
  const stats: WatchScanStats = {
    entries: 0,
    readableRuns: 0,
    unreadableRuns: 0,
    liveRuns: 0,
    invalidVerdicts: 0,
    archiveReadErrors: 0,
    rootReadErrors: 0,
    elapsedMs: 0,
  };
  const diagnostics: MutableDiagnostics = stats;
  const active = new Map<string, WatchAlert>();

  let entries: readonly string[] = [];
  try {
    entries = deps.readDirectory(deps.runsRoot);
  } catch {
    stats.rootReadErrors = 1;
  }
  stats.entries = entries.length;

  for (const runId of [...entries].sort()) {
    if (!safeEntryName(runId)) {
      stats.unreadableRuns += 1;
      continue;
    }
    const runDir = join(deps.runsRoot, runId);
    let state: JsonObject | undefined;
    try {
      state = parseObject(deps.readText(join(runDir, 'run.json')));
    } catch {
      state = undefined;
    }
    if (!state) {
      stats.unreadableRuns += 1;
      continue;
    }
    stats.readableRuns += 1;
    const mismatch = terminalArtifactStatusMismatch(state, {
      runDir,
      artifactMtimeMs: deps.artifactMtimeMs,
    });
    if (mismatch) {
      const alert: WatchTerminalStatusAlert = {
        kind: 'terminal_status_mismatch',
        conditionId: conditionId(
          'terminal_status_mismatch',
          runId,
          mismatch.lifecycleStatus,
          mismatch.terminalStatus,
          mismatch.terminalArtifact,
        ),
        runId,
        lifecycleStatus: mismatch.lifecycleStatus,
        terminalStatus: mismatch.terminalStatus,
        terminalArtifact: mismatch.terminalArtifact,
      };
      active.set(alert.conditionId, alert);
    }
    if (typeof state.status !== 'string' || !isRunningRunStatus(state.status)) continue;

    let pid: number | undefined;
    try {
      pid = parsePositiveInteger(deps.readText(join(runDir, 'scheduler.pid')));
    } catch {
      pid = undefined;
    }
    if (pid === undefined) continue;
    let live: boolean;
    try {
      live = deps.isProcessAlive(pid);
    } catch {
      live = false;
    }
    if (!live) continue;
    stats.liveRuns += 1;

    for (const condition of stageAttemptConditions(runId, state)) {
      active.set(condition.conditionId, condition);
    }
    const records = collectGateVerdicts(runDir, deps, diagnostics);
    for (const condition of gateConditions(runId, records)) {
      active.set(condition.conditionId, condition);
    }
  }

  stats.elapsedMs = Math.max(0, deps.nowMs() - startedAt);
  const alerts = [...active.values()]
    .filter((condition) => !previousState.activeConditionIds.has(condition.conditionId))
    .sort((a, b) => a.conditionId.localeCompare(b.conditionId));
  const state: WatchState = {
    initialized: true,
    activeConditionIds: new Set(active.keys()),
  };
  return {
    state,
    stats,
    heartbeat: previousState.initialized ? undefined : { kind: 'heartbeat', stats },
    alerts,
  };
}
