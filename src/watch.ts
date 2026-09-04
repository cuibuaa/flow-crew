import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPendingStageStatus,
  isRunningRunStatus,
  isRunningStageStatus,
  isTerminalRunStatus,
  runsRoot as globalRunsRoot,
  STAGE_STATUS,
} from './store.js';
import { terminalArtifactStatusMismatch } from './terminal-artifact-status.js';
import { listOperationalRunIdsFromIndex } from './run-index.js';

export interface WatchState {
  initialized: boolean;
  activeConditionIds: ReadonlySet<string>;
}

export interface WatchPollDependencies {
  runsRoot?: string;
  readDirectory?: (path: string) => readonly string[];
  /** Active/unknown candidates from the run index; null selects legacy root scan. */
  candidateRunIds?: (path: string) => readonly string[] | null;
  readText?: (path: string) => string;
  isProcessAlive?: (pid: number) => boolean;
  artifactMtimeMs?: (path: string) => number | undefined;
  readPathMetadata?: (path: string) => WatchPathMetadata | undefined;
  nowMs?: () => number;
}

export interface WatchPathMetadata {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  mtimeMs: number;
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

export interface WatchTerminalIndecisionAlert {
  kind: 'terminal_indecision';
  conditionId: string;
  runId: string;
  quietForMs: number;
  graceMs: number;
  pendingStages: number;
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
  movement: 'plateau' | 'regression';
}

export type WatchEvidenceKind =
  | 'runs_root'
  | 'run_state'
  | 'run_liveness'
  | 'terminal_shape'
  | 'terminal_activity'
  | 'gate_archive'
  | 'gate_comparison';

export type WatchEvidenceReason =
  | 'unavailable'
  | 'unreadable'
  | 'malformed'
  | 'metric_changed'
  | 'threshold_changed'
  | 'threshold_missing'
  | 'direction_changed'
  | 'rejection_contradiction'
  | 'threshold_crossed';

export interface WatchEvidenceGapAlert {
  kind: 'evidence_gap';
  conditionId: string;
  evidence: WatchEvidenceKind;
  reason: WatchEvidenceReason;
  count: number;
  runId?: string;
  gateId?: string;
}

export interface WatchTerminalStatusAlert {
  kind: 'terminal_status_mismatch';
  conditionId: string;
  runId: string;
  lifecycleStatus: string;
  terminalStatus: string;
  terminalArtifact: string;
}

export type WatchAlert =
  | WatchTerminalIndecisionAlert
  | WatchGateAlert
  | WatchEvidenceGapAlert
  | WatchTerminalStatusAlert;

export interface WatchPollResult {
  state: WatchState;
  stats: WatchScanStats;
  heartbeat?: WatchHeartbeat;
  alerts: WatchAlert[];
}

interface ResolvedWatchPollDependencies {
  runsRoot: string;
  readDirectory: (path: string) => readonly string[];
  candidateRunIds: (path: string) => readonly string[] | null;
  readText: (path: string) => string;
  isProcessAlive: (pid: number) => boolean;
  artifactMtimeMs?: (path: string) => number | undefined;
  readPathMetadata: (path: string) => WatchPathMetadata | undefined;
  nowMs: () => number;
}

interface JsonObject {
  [key: string]: unknown;
}

interface GateMetricEvidence {
  metric: string;
  score: number;
  threshold?: number;
  higherIsBetter?: boolean;
}

interface GateVerdictRecord {
  gateId: string;
  iteration: number;
  round: number;
  metric?: GateMetricEvidence;
}

interface MutableDiagnostics {
  invalidVerdicts: number;
  archiveReadErrors: number;
}

const ITERATION_DIRECTORY = /^iteration_(\d+)$/;
const ROUND_DIRECTORY = /^round_(\d+)$/;
const REJECTED_VERDICT_FILE = /^rejected_verdict_(.+)\.json$/;
const STAGE_ACTIVITY_FILE = /^(?:status\.json|live\.log|output(?:_attempt_\d+)?\.md)$/;
const QUIESCENT_STAGE_STATUSES = new Set<string>([
  STAGE_STATUS.PENDING,
  STAGE_STATUS.COMPLETE,
  STAGE_STATUS.FAILED,
  STAGE_STATUS.SKIPPED,
]);
const TOP_LEVEL_ACTIVITY_FILES = [
  'events.jsonl',
  'progress.md',
  'supervisor_log.md',
  'supervisor_state.json',
] as const;

/** The primary lag maximum (513.037s), rounded up to twelve 45-second polls. */
export const WATCH_TERMINAL_GRACE_MS = 540_000;

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

function pathMetadata(path: string): WatchPathMetadata | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const kind = stats.isSymbolicLink()
    ? 'symlink'
    : stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : 'other';
  return { kind, mtimeMs: stats.mtimeMs };
}

function resolveDependencies(overrides: WatchPollDependencies): ResolvedWatchPollDependencies {
  const root = overrides.runsRoot ?? globalRunsRoot();
  return {
    runsRoot: root,
    readDirectory: overrides.readDirectory ?? ((path) => readdirSync(path)),
    candidateRunIds: overrides.candidateRunIds
      ?? (overrides.readDirectory
        ? (() => null)
        : (() => listOperationalRunIdsFromIndex(''))),
    readText: overrides.readText ?? ((path) => readFileSync(path, 'utf-8')),
    isProcessAlive: overrides.isProcessAlive ?? processIsAlive,
    artifactMtimeMs: overrides.artifactMtimeMs,
    readPathMetadata: overrides.readPathMetadata ?? pathMetadata,
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

function parseLegacyVerdictMetric(verdict: JsonObject): GateMetricEvidence | undefined {
  const score = typeof verdict.score === 'number' && Number.isFinite(verdict.score)
    ? verdict.score
    : typeof verdict.value === 'number' && Number.isFinite(verdict.value)
      ? verdict.value
      : undefined;
  if (typeof verdict.metric !== 'string'
    || verdict.metric.trim().length === 0
    || score === undefined) return undefined;
  return {
    metric: verdict.metric,
    score,
    ...(typeof verdict.threshold === 'number' && Number.isFinite(verdict.threshold)
      ? { threshold: verdict.threshold }
      : {}),
    ...(typeof verdict.higherIsBetter === 'boolean'
      ? { higherIsBetter: verdict.higherIsBetter }
      : {}),
  };
}

function parseMetricArtifact(metric: JsonObject): GateMetricEvidence | undefined {
  if (metric.hasMetric !== true) return undefined;
  const score = typeof metric.value === 'number' && Number.isFinite(metric.value)
    ? metric.value
    : typeof metric.score === 'number' && Number.isFinite(metric.score)
      ? metric.score
      : undefined;
  if (typeof metric.metric !== 'string'
    || metric.metric.trim().length === 0
    || score === undefined) return undefined;
  return {
    metric: metric.metric,
    score,
    ...(typeof metric.threshold === 'number' && Number.isFinite(metric.threshold)
      ? { threshold: metric.threshold }
      : {}),
    ...(typeof metric.higherIsBetter === 'boolean'
      ? { higherIsBetter: metric.higherIsBetter }
      : {}),
  };
}

function readVerdict(
  roundDir: string,
  verdictFile: string,
  gateId: string,
  iteration: number,
  round: number,
  deps: ResolvedWatchPollDependencies,
  diagnostics: MutableDiagnostics,
): GateVerdictRecord | undefined {
  const record: GateVerdictRecord = { gateId, iteration, round };
  let verdict: JsonObject | undefined;
  try {
    verdict = parseObject(deps.readText(join(roundDir, verdictFile)));
  } catch {
    verdict = undefined;
  }
  if (!verdict) {
    diagnostics.invalidVerdicts += 1;
    return record;
  }
  const legacyMetric = parseLegacyVerdictMetric(verdict);
  if (verdict.pass === true || (typeof verdict.pass !== 'boolean' && !legacyMetric)) {
    diagnostics.invalidVerdicts += 1;
    return record;
  }

  let rawMetric: JsonObject | undefined;
  try {
    rawMetric = parseObject(deps.readText(join(roundDir, `metric_${gateId}.json`)));
  } catch (error) {
    if (isMissingPathError(error)) {
      return legacyMetric ? { ...record, metric: legacyMetric } : record;
    }
    diagnostics.invalidVerdicts += 1;
    return record;
  }
  if (!rawMetric || (rawMetric.hasMetric !== true && rawMetric.hasMetric !== false)) {
    diagnostics.invalidVerdicts += 1;
    return record;
  }
  if (rawMetric.hasMetric === false) return record;

  const metric = parseMetricArtifact(rawMetric);
  if (!metric) {
    diagnostics.invalidVerdicts += 1;
    return record;
  }
  return { ...record, metric };
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
      roundDir,
      file,
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

function evidenceGap(
  evidence: WatchEvidenceKind,
  reason: WatchEvidenceReason,
  options: { count?: number; runId?: string; gateId?: string } = {},
): WatchEvidenceGapAlert {
  return {
    kind: 'evidence_gap',
    conditionId: conditionId(
      'evidence_gap',
      evidence,
      ...(options.runId ? [options.runId] : []),
      ...(options.gateId ? [options.gateId] : []),
    ),
    evidence,
    reason,
    count: options.count ?? 1,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.gateId ? { gateId: options.gateId } : {}),
  };
}

interface TerminalQuiescence {
  pendingStages: number;
  stageIds: string[];
}

function validTerminalContract(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([status, rawEntry]) => {
    if (!isTerminalRunStatus(status)
      || !rawEntry
      || typeof rawEntry !== 'object'
      || Array.isArray(rawEntry)) {
      return false;
    }
    const paths = (rawEntry as JsonObject).paths;
    return Array.isArray(paths)
      && paths.length > 0
      && paths.every((path) => typeof path === 'string' && path.trim().length > 0);
  });
}

function terminalQuiescence(
  state: JsonObject,
): TerminalQuiescence | WatchEvidenceReason | undefined {
  if (state.terminalStates === undefined) return undefined;
  if (!validTerminalContract(state.terminalStates)) return 'malformed';
  if (state.terminalArtifact !== undefined) {
    return typeof state.terminalArtifact === 'string' && state.terminalArtifact.length > 0
      ? undefined
      : 'malformed';
  }
  if (state.completedAt !== undefined) return 'malformed';
  if (!state.stages || typeof state.stages !== 'object' || Array.isArray(state.stages)) {
    return 'malformed';
  }
  const entries = Object.entries(state.stages);
  if (entries.length === 0) return undefined;
  let pendingStages = 0;
  let settledStages = 0;
  let executing = false;
  const stageIds: string[] = [];
  for (const [stageId, rawStage] of entries) {
    if (!safeEntryName(stageId)
      || !rawStage
      || typeof rawStage !== 'object'
      || Array.isArray(rawStage)) {
      return 'malformed';
    }
    const status = (rawStage as JsonObject).status;
    if (typeof status !== 'string' || !QUIESCENT_STAGE_STATUSES.has(status)) {
      if (typeof status === 'string' && isRunningStageStatus(status)) executing = true;
      else return 'malformed';
    } else if (isPendingStageStatus(status)) {
      pendingStages += 1;
    } else {
      settledStages += 1;
    }
    stageIds.push(stageId);
  }
  if (executing || settledStages === 0) return undefined;
  return { pendingStages, stageIds };
}

type ActivityClock = { latestMtimeMs: number } | { reason: WatchEvidenceReason };

function terminalActivityClock(
  runDir: string,
  stageIds: readonly string[],
  deps: ResolvedWatchPollDependencies,
): ActivityClock {
  let latestMtimeMs = Number.NEGATIVE_INFINITY;
  const includeFile = (path: string, required: boolean): WatchEvidenceReason | undefined => {
    let metadata: WatchPathMetadata | undefined;
    try {
      metadata = deps.readPathMetadata(path);
    } catch {
      return 'unreadable';
    }
    if (!metadata) return required ? 'unreadable' : undefined;
    if (metadata.kind !== 'file' || !Number.isFinite(metadata.mtimeMs)) return 'malformed';
    latestMtimeMs = Math.max(latestMtimeMs, metadata.mtimeMs);
    return undefined;
  };

  let runMetadata: WatchPathMetadata | undefined;
  try {
    runMetadata = deps.readPathMetadata(runDir);
  } catch {
    return { reason: 'unreadable' };
  }
  if (!runMetadata || runMetadata.kind !== 'directory') return { reason: 'malformed' };
  const runStateProblem = includeFile(join(runDir, 'run.json'), true);
  if (runStateProblem) return { reason: runStateProblem };
  for (const name of TOP_LEVEL_ACTIVITY_FILES) {
    const problem = includeFile(join(runDir, name), false);
    if (problem) return { reason: problem };
  }

  const stagesRoot = join(runDir, 'stages');
  let stagesMetadata: WatchPathMetadata | undefined;
  try {
    stagesMetadata = deps.readPathMetadata(stagesRoot);
  } catch {
    return { reason: 'unreadable' };
  }
  if (stagesMetadata && stagesMetadata.kind !== 'directory') return { reason: 'malformed' };

  for (const stageId of stagesMetadata ? stageIds : []) {
    const stageDir = join(stagesRoot, stageId);
    let stageMetadata: WatchPathMetadata | undefined;
    try {
      stageMetadata = deps.readPathMetadata(stageDir);
    } catch {
      return { reason: 'unreadable' };
    }
    if (!stageMetadata) continue;
    if (stageMetadata.kind !== 'directory') return { reason: 'malformed' };
    let files: readonly string[];
    try {
      files = deps.readDirectory(stageDir);
    } catch {
      return { reason: 'unreadable' };
    }
    for (const file of files) {
      if (!safeEntryName(file) || !STAGE_ACTIVITY_FILE.test(file)) continue;
      const problem = includeFile(join(stageDir, file), true);
      if (problem) return { reason: problem };
    }
  }
  return Number.isFinite(latestMtimeMs)
    ? { latestMtimeMs }
    : { reason: 'unreadable' };
}

function gateConditions(
  runId: string,
  records: GateVerdictRecord[],
): Array<WatchGateAlert | WatchEvidenceGapAlert> {
  const byGate = new Map<string, GateVerdictRecord[]>();
  for (const record of records) {
    const previous = byGate.get(record.gateId) ?? [];
    previous.push(record);
    byGate.set(record.gateId, previous);
  }

  const alerts: Array<WatchGateAlert | WatchEvidenceGapAlert> = [];
  for (const [gateId, rows] of byGate) {
    rows.sort((a, b) => a.iteration - b.iteration || a.round - b.round);
    if (rows.length < 2) continue;
    const latest = rows.at(-1)!;
    const previous = rows.at(-2)!;
    const latestMetric = latest.metric;
    const previousMetric = previous.metric;
    if (!latestMetric || !previousMetric) continue;
    if (previousMetric.metric !== latestMetric.metric) {
      alerts.push(evidenceGap('gate_comparison', 'metric_changed', { runId, gateId }));
      continue;
    }
    if (previousMetric.higherIsBetter !== latestMetric.higherIsBetter) {
      alerts.push(evidenceGap('gate_comparison', 'direction_changed', { runId, gateId }));
      continue;
    }
    if (previousMetric.threshold === undefined || latestMetric.threshold === undefined) {
      alerts.push(evidenceGap('gate_comparison', 'threshold_missing', { runId, gateId }));
      continue;
    }
    if (previousMetric.threshold !== latestMetric.threshold) {
      alerts.push(evidenceGap('gate_comparison', 'threshold_changed', { runId, gateId }));
      continue;
    }
    const previousSide = Math.sign(previousMetric.score - previousMetric.threshold);
    const latestSide = Math.sign(latestMetric.score - latestMetric.threshold);
    if (previousSide === 0 || latestSide === 0 || previousSide !== latestSide) {
      alerts.push(evidenceGap('gate_comparison', 'threshold_crossed', { runId, gateId }));
      continue;
    }
    if (latestMetric.higherIsBetter !== undefined) {
      const previousFails = latestMetric.higherIsBetter
        ? previousMetric.score < previousMetric.threshold
        : previousMetric.score > previousMetric.threshold;
      const latestFails = latestMetric.higherIsBetter
        ? latestMetric.score < latestMetric.threshold
        : latestMetric.score > latestMetric.threshold;
      if (!previousFails || !latestFails) {
        alerts.push(evidenceGap('gate_comparison', 'rejection_contradiction', { runId, gateId }));
        continue;
      }
    }
    const previousDistance = Math.abs(previousMetric.score - previousMetric.threshold);
    const latestDistance = Math.abs(latestMetric.score - latestMetric.threshold);
    if (latestDistance < previousDistance) continue;
    let rejections = 1;
    for (let index = rows.length - 2; index >= 0; index -= 1) {
      const rowMetric = rows[index].metric;
      if (!rowMetric
        || rowMetric.metric !== latestMetric.metric
        || rowMetric.threshold !== latestMetric.threshold
        || rowMetric.higherIsBetter !== latestMetric.higherIsBetter
        || rowMetric.threshold === undefined
        || Math.sign(rowMetric.score - rowMetric.threshold) !== latestSide) break;
      rejections += 1;
    }
    alerts.push({
      kind: 'gate_not_converging',
      conditionId: conditionId('gate_not_converging', runId, gateId, latestMetric.metric),
      runId,
      gateId,
      metric: latestMetric.metric,
      previousScore: previousMetric.score,
      latestScore: latestMetric.score,
      threshold: latestMetric.threshold,
      rejections,
      movement: latestDistance === previousDistance ? 'plateau' : 'regression',
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
  const unjudgeableRunIds = new Set<string>();
  let livenessGaps = 0;

  let entries: readonly string[] = [];
  try {
    entries = deps.candidateRunIds(deps.runsRoot) ?? deps.readDirectory(deps.runsRoot);
  } catch {
    try {
      // A missing/unavailable index is a compatibility condition, not proof
      // that the runs root is unreadable. Fall back to the legacy scan.
      entries = deps.readDirectory(deps.runsRoot);
    } catch {
      stats.rootReadErrors = 1;
    }
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
      unjudgeableRunIds.add(runId);
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
    if (pid === undefined) {
      livenessGaps += 1;
      unjudgeableRunIds.add(runId);
      continue;
    }
    let live: boolean;
    try {
      live = deps.isProcessAlive(pid);
    } catch {
      livenessGaps += 1;
      unjudgeableRunIds.add(runId);
      continue;
    }
    if (!live) continue;
    stats.liveRuns += 1;

    if (!mismatch) {
      const quiescence = terminalQuiescence(state);
      if (typeof quiescence === 'string') {
        const gap = evidenceGap('terminal_shape', quiescence, { runId });
        active.set(gap.conditionId, gap);
        unjudgeableRunIds.add(runId);
      } else if (quiescence) {
        const activity = terminalActivityClock(runDir, quiescence.stageIds, deps);
        if ('reason' in activity) {
          const gap = evidenceGap('terminal_activity', activity.reason, { runId });
          active.set(gap.conditionId, gap);
          unjudgeableRunIds.add(runId);
        } else {
          const quietForMs = Math.max(0, startedAt - activity.latestMtimeMs);
          if (quietForMs >= WATCH_TERMINAL_GRACE_MS) {
            const alert: WatchTerminalIndecisionAlert = {
              kind: 'terminal_indecision',
              conditionId: conditionId('terminal_indecision', runId),
              runId,
              quietForMs,
              graceMs: WATCH_TERMINAL_GRACE_MS,
              pendingStages: quiescence.pendingStages,
            };
            active.set(alert.conditionId, alert);
          }
        }
      }
    }
    const invalidBefore = stats.invalidVerdicts;
    const archiveErrorsBefore = stats.archiveReadErrors;
    const records = collectGateVerdicts(runDir, deps, diagnostics);
    const gateEvidenceGaps = (stats.invalidVerdicts - invalidBefore)
      + (stats.archiveReadErrors - archiveErrorsBefore);
    if (gateEvidenceGaps > 0) {
      const gap = evidenceGap('gate_archive', 'unreadable', {
        count: gateEvidenceGaps,
        runId,
      });
      active.set(gap.conditionId, gap);
      unjudgeableRunIds.add(runId);
    }
    if (gateEvidenceGaps === 0) {
      for (const condition of gateConditions(runId, records)) {
        active.set(condition.conditionId, condition);
      }
    }
  }

  if (stats.rootReadErrors > 0) {
    const gap = evidenceGap('runs_root', 'unavailable');
    active.set(gap.conditionId, gap);
  }
  if (stats.unreadableRuns > 0) {
    const gap = evidenceGap('run_state', 'unreadable', { count: stats.unreadableRuns });
    active.set(gap.conditionId, gap);
  }
  if (livenessGaps > 0) {
    const gap = evidenceGap('run_liveness', 'unreadable', { count: livenessGaps });
    active.set(gap.conditionId, gap);
  }
  stats.elapsedMs = Math.max(0, deps.nowMs() - startedAt);
  const alerts = [...active.values()]
    .filter((condition) => !previousState.activeConditionIds.has(condition.conditionId))
    .sort((a, b) => a.conditionId.localeCompare(b.conditionId));
  const activeConditionIds = new Set(active.keys());
  if (stats.rootReadErrors > 0) {
    // An unavailable root proves neither recovery nor persistence. Retain prior
    // edges so a root outage cannot make every unchanged stall fire again.
    for (const priorId of previousState.activeConditionIds) activeConditionIds.add(priorId);
  } else if (unjudgeableRunIds.size > 0) {
    for (const priorId of previousState.activeConditionIds) {
      try {
        const parts: unknown = JSON.parse(priorId);
        if (!Array.isArray(parts)) continue;
        const runId = parts[0] === 'evidence_gap' ? parts[2] : parts[1];
        if (typeof runId === 'string' && unjudgeableRunIds.has(runId)) {
          activeConditionIds.add(priorId);
        }
      } catch {
        // Condition IDs are generated internally; ignore an incompatible old version.
      }
    }
  }
  const state: WatchState = {
    initialized: true,
    activeConditionIds,
  };
  return {
    state,
    stats,
    heartbeat: previousState.initialized ? undefined : { kind: 'heartbeat', stats },
    alerts,
  };
}
