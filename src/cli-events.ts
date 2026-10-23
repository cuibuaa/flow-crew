import { parseJsonl } from './jsonl.js';
import { CliUsageError, commandUsage, parseCommandArgs } from './cli-args.js';
import { closeSync, openSync } from './engine-fs.js';
import { existsSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listOperationalRunIdsFromIndex } from './run-index.js';
import { isRunningRunStatus } from './lifecycle-status.js';
import {
  buildRunDriftProjection,
  readRunDriftProjection,
  type RunDriftProjection,
} from './run-drift.js';
import { runsRoot as defaultRunsRoot } from './store.js';

export { formatRunDriftProjection } from './run-drift.js';

type Writer = { write(chunk: string): unknown };

export interface EventLike {
  type?: unknown;
  event?: unknown;
  runId?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  stageId?: unknown;
  stage?: unknown;
  attemptIndex?: unknown;
  detail?: unknown;
  message?: unknown;
  reason?: unknown;
  decision?: unknown;
  runStatus?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface StageLike {
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  retries?: unknown;
  reruns?: unknown;
  attempts?: unknown;
}

export interface OperationalRunState {
  runId?: unknown;
  projectDir?: unknown;
  workflowName?: unknown;
  taskDescription?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  failureReason?: unknown;
  stages?: unknown;
  parked?: unknown;
}

export interface OperationalEventReason {
  type: string;
  at?: string;
  stageId?: string;
  attemptIndex?: number;
  /** True when this reason does not describe the currently executing stage attempt. */
  historical?: boolean;
  detail: string;
}

export interface OperationalStageExecution {
  id: string;
  status: string;
  execution: number;
  startedAt?: string;
  elapsedMs?: number;
}

export interface OperationalPendingScope {
  requestId: string;
  stageId?: string;
  requestedAt?: string;
  detail?: string;
}

export interface OperationalProjection {
  version: 1;
  runId?: string;
  projectDir?: string;
  runStatus: string;
  runElapsedMs?: number;
  activeStages: OperationalStageExecution[];
  latestReason?: OperationalEventReason;
  lastRejection?: OperationalEventReason;
  lastGuidance?: OperationalEventReason;
  pendingScope: OperationalPendingScope[];
  pendingApproval?: {
    requestId: string;
    stageId?: string;
    requestedAt?: string;
    detail: string;
  };
  /** Shared bounded rows rendered by status, watch, and task show. */
  drift?: RunDriftProjection;
  sourceCoverage: {
    runState: 'read' | 'unavailable';
    events: 'read' | 'missing' | 'unreadable';
    stageCount: number;
  };
}

const ACTIONABLE_EVENT_TYPES = new Set([
  'attempt_failed',
  'stage_failed',
  'guidance_written',
  'admission_rejected',
  'plan_dispatch_retry',
  'run_status_changed',
  'operator_wrap_up_required',
  'approval_parked',
  'approval_resolved',
]);

const REJECTION_EVENT_TYPES = new Set([
  'attempt_failed',
  'stage_failed',
  'admission_rejected',
  'plan_dispatch_retry',
]);

const DEFAULT_EVENT_TAIL_BYTES = 512 * 1024;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eventType(event: EventLike): string {
  return text(event.type) ?? text(event.event) ?? 'event';
}

function eventTimestamp(event: EventLike): string | undefined {
  return text(event.timestamp) ?? text(event.ts);
}

function eventStage(event: EventLike): string | undefined {
  return text(event.stageId) ?? text(event.stage);
}

function eventDetail(event: EventLike): string | undefined {
  return text(event.detail)
    ?? text(event.message)
    ?? text(event.reason)
    ?? (text(event.decision) ? `decision ${text(event.decision)}` : undefined)
    ?? (text(event.runStatus) ? `run status ${text(event.runStatus)}` : undefined)
    ?? (text(event.status) ? `status ${text(event.status)}` : undefined);
}

function eventFiles(event: EventLike): string[] {
  return Array.isArray(event.files)
    ? event.files.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

function reasonFromEvent(event: EventLike): OperationalEventReason | undefined {
  const detail = eventDetail(event);
  if (!detail) return undefined;
  const at = eventTimestamp(event);
  const stageId = eventStage(event);
  const attemptIndex = finite(event.attemptIndex);
  return {
    type: eventType(event),
    ...(at ? { at } : {}),
    ...(stageId ? { stageId } : {}),
    ...(attemptIndex !== undefined ? { attemptIndex: Math.floor(attemptIndex) } : {}),
    detail,
  };
}

/** Render reason provenance so historical failures cannot masquerade as live state. */
export function formatOperationalReason(reason: OperationalEventReason): string {
  const provenance = [
    reason.historical === false ? 'current' : 'historical',
    `stage ${reason.stageId ?? 'unknown'}`,
    `attempt ${reason.attemptIndex ?? 'unknown'}`,
    reason.at ?? 'time unknown',
  ];
  return `[${provenance.join(' · ')}]: ${reason.detail}`;
}

function objectEntries(value: unknown): Array<[string, StageLike]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, StageLike] => Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1]));
}

function executionNumber(stage: StageLike): number {
  const attempts = Array.isArray(stage.attempts)
    ? stage.attempts.filter((attempt) => Boolean(attempt) && typeof attempt === 'object') as Record<string, unknown>[]
    : [];
  const last = attempts.at(-1);
  const recorded = finite(last?.index);
  if (recorded !== undefined) {
    return Math.max(1, Math.floor(recorded) + (text(last?.status) === 'running' ? 0 : 1));
  }
  if (attempts.length > 0) return attempts.length + (text(last?.status) === 'running' ? 0 : 1);
  const retries = finite(stage.retries) ?? 0;
  return Math.max(1, Math.floor(retries) + 1);
}

function currentExecutionStartedAt(stage: StageLike): string | undefined {
  const attempts = Array.isArray(stage.attempts)
    ? stage.attempts.filter((attempt) => Boolean(attempt) && typeof attempt === 'object') as Record<string, unknown>[]
    : [];
  const current = [...attempts].reverse().find((attempt) => text(attempt.status) === 'running');
  return text(current?.startedAt) ?? text(stage.startedAt);
}

function elapsedSince(startedAt: string | undefined, endedAt: string | undefined, nowMs: number): number | undefined {
  const start = timestampMs(startedAt);
  if (start === undefined) return undefined;
  const end = timestampMs(endedAt) ?? nowMs;
  return Math.max(0, end - start);
}

function pendingApproval(state: OperationalRunState): OperationalProjection['pendingApproval'] {
  if (!state.parked || typeof state.parked !== 'object' || Array.isArray(state.parked)) return undefined;
  const parked = state.parked as Record<string, unknown>;
  const requestId = text(parked.requestId);
  if (!requestId) return undefined;
  const stageId = text(parked.stageId);
  const requestedAt = text(parked.requestedAt);
  return {
    requestId,
    ...(stageId ? { stageId } : {}),
    ...(requestedAt ? { requestedAt } : {}),
    detail: text(parked.reason) ?? text(parked.action) ?? 'operator approval is required',
  };
}

export function buildOperationalProjection(
  state: OperationalRunState | undefined,
  events: readonly EventLike[] = [],
  options: {
    nowMs?: number;
    eventsCoverage?: OperationalProjection['sourceCoverage']['events'];
    includeDrift?: boolean;
    drift?: RunDriftProjection;
  } = {},
): OperationalProjection {
  const nowMs = options.nowMs ?? Date.now();
  const stageEntries = objectEntries(state?.stages);
  const activeStages = stageEntries
    .filter(([, stage]) => text(stage.status) === 'running')
    .map(([id, stage]): OperationalStageExecution => {
      const startedAt = currentExecutionStartedAt(stage);
      const elapsedMs = elapsedSince(startedAt, undefined, nowMs);
      return {
        id,
        status: 'running',
        execution: executionNumber(stage),
        ...(startedAt ? { startedAt } : {}),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      };
    });

  let latestReason: OperationalEventReason | undefined;
  let lastRejection: OperationalEventReason | undefined;
  let lastGuidance: OperationalEventReason | undefined;
  for (const event of events) {
    const type = eventType(event);
    const reason = reasonFromEvent(event);
    if (!reason) continue;
    if (ACTIONABLE_EVENT_TYPES.has(type)) latestReason = reason;
    if (REJECTION_EVENT_TYPES.has(type)) lastRejection = reason;
    if (type === 'guidance_written') lastGuidance = reason;
  }
  const failureReason = text(state?.failureReason);
  if (!latestReason && failureReason) latestReason = { type: 'run_failure', detail: failureReason };
  if (!lastRejection && failureReason) lastRejection = { type: 'run_failure', detail: failureReason };

  const markHistorical = (reason: OperationalEventReason | undefined): OperationalEventReason | undefined => {
    if (!reason) return undefined;
    const current = reason.stageId !== undefined
      && reason.attemptIndex !== undefined
      && activeStages.some((stage) => stage.id === reason.stageId && stage.execution === reason.attemptIndex);
    return { ...reason, historical: !current };
  };
  latestReason = markHistorical(latestReason);
  lastRejection = markHistorical(lastRejection);
  lastGuidance = markHistorical(lastGuidance);

  const runId = text(state?.runId);
  const projectDir = text(state?.projectDir);
  const runStatus = text(state?.status) ?? 'unknown';
  const runElapsedMs = elapsedSince(
    text(state?.startedAt),
    isRunningRunStatus(runStatus) ? undefined : text(state?.completedAt),
    nowMs,
  );
  const approval = pendingApproval(state ?? {});
  const drift = options.includeDrift === false
    ? undefined
    : options.drift ?? buildRunDriftProjection(state, events);
  return {
    version: 1,
    ...(runId ? { runId } : {}),
    ...(projectDir ? { projectDir } : {}),
    runStatus,
    ...(runElapsedMs === undefined ? {} : { runElapsedMs }),
    activeStages,
    ...(latestReason ? { latestReason } : {}),
    ...(lastRejection ? { lastRejection } : {}),
    ...(lastGuidance ? { lastGuidance } : {}),
    pendingScope: [],
    ...(approval ? { pendingApproval: approval } : {}),
    ...(drift ? { drift } : {}),
    sourceCoverage: {
      runState: state ? 'read' : 'unavailable',
      events: options.eventsCoverage ?? 'read',
      stageCount: stageEntries.length,
    },
  };
}

function readTail(path: string, maxBytes = DEFAULT_EVENT_TAIL_BYTES): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length === 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let value = buffer.subarray(0, bytesRead).toString('utf-8');
    if (start > 0) {
      const firstNewline = value.indexOf('\n');
      value = firstNewline < 0 ? '' : value.slice(firstNewline + 1);
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

export function readOperatorEvents(runDirectory: string, maxEvents = 500): EventLike[] {
  const path = join(runDirectory, 'events.jsonl');
  if (!existsSync(path)) return [];
  return parseJsonl<unknown>(readTail(path))
    .filter((parsed): parsed is EventLike => !!parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    .slice(-Math.max(0, maxEvents));
}

export function readOperationalProjection(
  runDirectory: string,
  options: { nowMs?: number; state?: OperationalRunState; includeDrift?: boolean } = {},
): OperationalProjection {
  let state = options.state;
  if (!state) {
    try { state = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf-8')) as OperationalRunState; } catch { /* reported below */ }
  }
  let events: EventLike[] = [];
  let eventsCoverage: OperationalProjection['sourceCoverage']['events'] = 'missing';
  try {
    const path = join(runDirectory, 'events.jsonl');
    if (existsSync(path)) {
      events = readOperatorEvents(runDirectory);
      eventsCoverage = 'read';
    }
  } catch {
    eventsCoverage = 'unreadable';
  }
  const drift = options.includeDrift === false
    ? undefined
    : readRunDriftProjection(runDirectory, { state, events, eventsCoverage });
  return buildOperationalProjection(state, events, {
    nowMs: options.nowMs,
    eventsCoverage,
    includeDrift: options.includeDrift,
    ...(drift ? { drift } : {}),
  });
}

export function formatHumanDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface ParsedEventArgs {
  help: boolean;
  follow: boolean;
  json: boolean;
  limit: number;
  runId?: string;
  projectDir?: string;
  stageId?: string;
  types: Set<string>;
}

export interface CliEventsDependencies {
  stdout?: Writer;
  stderr?: Writer;
  runsRoot?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  followPollMs?: number;
  maxFollowPolls?: number;
}

function safeRunId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

function parseEventArgs(args: string[]): ParsedEventArgs {
  const { help, flags, values } = parseCommandArgs('events', args);
  const runId = values.get('--run');
  if (runId && !safeRunId(runId)) throw new Error('--run must be a run id, not a path');
  return {
    help,
    follow: flags.has('--follow'),
    json: flags.has('--json'),
    limit: Number(values.get('--limit') ?? 100),
    runId,
    projectDir: values.has('--project') ? resolve(values.get('--project')!) : undefined,
    stageId: values.get('--stage'),
    types: new Set((values.get('--type') ?? '').split(',').map(value => value.trim()).filter(Boolean)),
  };
}

export function eventsUsage(): string {
  return [
    commandUsage('events'),
    'Reads the canonical run event feed. Detail and stage context are retained.',
    'Without --run, only operational runs for the selected/current project are followed.',
  ].join('\n');
}

function readRunStateForSelection(runRoot: string, runId: string): OperationalRunState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runRoot, runId, 'run.json'), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as OperationalRunState : undefined;
  } catch {
    return undefined;
  }
}

function canonicalPath(path: string): string {
  try { return resolve(path); } catch { return path; }
}

function selectedRunIds(parsed: ParsedEventArgs, deps: Required<Pick<CliEventsDependencies, 'runsRoot'>>): string[] {
  if (parsed.runId) return [parsed.runId];
  const projectDir = parsed.projectDir ?? resolve(process.cwd());
  const indexed = listOperationalRunIdsFromIndex(projectDir);
  const candidates = indexed ?? (() => {
    try { return readdirSync(deps.runsRoot); } catch { return []; }
  })();
  return candidates.filter((runId) => {
    if (!safeRunId(runId)) return false;
    const state = readRunStateForSelection(deps.runsRoot, runId);
    return canonicalPath(text(state?.projectDir) ?? '') === canonicalPath(projectDir);
  });
}

function matchesEvent(event: EventLike, parsed: ParsedEventArgs): boolean {
  const type = eventType(event);
  if (parsed.types.size > 0 && !parsed.types.has(type)) return false;
  if (parsed.stageId && eventStage(event) !== parsed.stageId) return false;
  return true;
}

function formatHumanEvent(runId: string, event: EventLike): string {
  const timestamp = eventTimestamp(event) ?? 'unknown-time';
  const stage = eventStage(event);
  const attempt = finite(event.attemptIndex);
  const context = [stage ? `stage=${stage}` : '', attempt === undefined ? '' : `execution=${attempt}`].filter(Boolean).join(' ');
  const detail = eventDetail(event);
  const files = eventFiles(event);
  return `${timestamp} ${runId} ${eventType(event)}${context ? ` ${context}` : ''}`
    + `${files.length > 0 ? ` paths=${files.join(',')}` : ''}${detail ? ` — ${detail}` : ''}`;
}

function emitEvents(
  runRoot: string,
  runIds: readonly string[],
  parsed: ParsedEventArgs,
  stdout: Writer,
  cursors: Map<string, string | undefined>,
  initial: boolean,
): number {
  const rows: Array<{ runId: string; event: EventLike }> = [];
  for (const runId of runIds) {
    const events = readOperatorEvents(join(runRoot, runId), initial ? Math.max(parsed.limit, 500) : 500);
    const prior = cursors.get(runId);
    const priorIndex = prior === undefined
      ? -1
      : events.map((event) => JSON.stringify(event)).lastIndexOf(prior);
    const next = initial
      ? events.slice(Math.max(0, events.length - parsed.limit))
      : priorIndex >= 0 ? events.slice(priorIndex + 1) : events;
    cursors.set(runId, events.at(-1) ? JSON.stringify(events.at(-1)) : prior);
    for (const event of next) if (matchesEvent(event, parsed)) rows.push({ runId, event });
  }
  rows.sort((left, right) => (eventTimestamp(left.event) ?? '').localeCompare(eventTimestamp(right.event) ?? ''));
  const bounded = initial ? rows.slice(-parsed.limit) : rows;
  for (const { runId, event } of bounded) {
    if (parsed.json) stdout.write(`${JSON.stringify({ ...event, runId: text(event.runId) ?? runId })}\n`);
    else stdout.write(`${formatHumanEvent(runId, event)}\n`);
  }
  return bounded.length;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function cmdEventsWithDeps(args: string[], overrides: CliEventsDependencies = {}): Promise<number> {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  let parsed: ParsedEventArgs;
  try {
    parsed = parseEventArgs(args);
  } catch (error) {
    stderr.write(`events: ${error instanceof Error ? error.message : String(error)}\n`);
    if (!(error instanceof CliUsageError)) stderr.write(`${eventsUsage()}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${eventsUsage()}\n`);
    return 0;
  }

  const runRoot = resolve(overrides.runsRoot ?? defaultRunsRoot());
  const deps = {
    runsRoot: runRoot,
  };
  if (parsed.runId && !existsSync(join(runRoot, parsed.runId, 'run.json'))) {
    stderr.write(`events: run ${parsed.runId} was not found or has no readable run.json\n`);
    return 1;
  }
  if (parsed.runId && parsed.projectDir) {
    const state = readRunStateForSelection(runRoot, parsed.runId);
    if (canonicalPath(text(state?.projectDir) ?? '') !== canonicalPath(parsed.projectDir)) {
      stderr.write(`events: run ${parsed.runId} does not belong to project ${parsed.projectDir}\n`);
      return 1;
    }
  }

  const cursors = new Map<string, string | undefined>();
  let runIds = selectedRunIds(parsed, deps);
  let stopped = false;
  const stop = () => { stopped = true; };
  // Follow mode owns signals before emitting even the first row: a writer can
  // synchronously receive an interrupt while that row is being rendered.
  if (parsed.follow) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    const emitted = emitEvents(runRoot, runIds, parsed, stdout, cursors, true);
    if (!parsed.follow) {
      if (emitted === 0 && !parsed.json) stdout.write('No matching run events.\n');
      return 0;
    }
    const sleep = overrides.sleep ?? wait;
    const pollMs = overrides.followPollMs ?? 1_000;
    let polls = 0;
    while (!stopped && (overrides.maxFollowPolls === undefined || polls < overrides.maxFollowPolls)) {
      await sleep(pollMs);
      polls += 1;
      runIds = selectedRunIds(parsed, deps);
      emitEvents(runRoot, runIds, parsed, stdout, cursors, false);
    }
  } finally {
    if (parsed.follow) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  return 0;
}

export async function cmdEvents(args: string[]): Promise<number> {
  return cmdEventsWithDeps(args);
}
