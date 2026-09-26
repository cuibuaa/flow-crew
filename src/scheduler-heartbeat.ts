import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { appendRunEventAtRunDir } from './run-events.js';
import { isLiveFlowcrewSchedulerForRun } from './run-lock.js';
import { isRunningRunStatus } from './store.js';

export const SCHEDULER_HEARTBEAT_FILE = 'scheduler-heartbeat.json';
export const SCHEDULER_LOOP_STALL_FILE = 'scheduler-loop-stall.json';

export interface SchedulerHeartbeatRecord {
  version: 1;
  runId: string;
  pid: number;
  generation: string;
  sequence: number;
  startedAt: string;
  updatedAt: string;
  state: 'running' | 'stopped';
}

export interface SchedulerLoopStallWarning {
  version: 1;
  kind: 'scheduler_loop_stall';
  runId: string;
  pid: number;
  generation: string;
  active: boolean;
  detectedAt: string;
  lastHeartbeatAt: string;
  lastSequence: number;
  thresholdMs: number;
  recoveredAt?: string;
  clearedReason?: string;
}

function parseJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return undefined; }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function heartbeatPath(runPath: string): string {
  return join(runPath, SCHEDULER_HEARTBEAT_FILE);
}

function warningPath(runPath: string): string {
  return join(runPath, SCHEDULER_LOOP_STALL_FILE);
}

function readRunStatus(runPath: string): string | undefined {
  const state = parseJson<{ status?: unknown }>(join(runPath, 'run.json'));
  return typeof state?.status === 'string' ? state.status : undefined;
}

export function readActiveSchedulerLoopStall(runPath: string): SchedulerLoopStallWarning | undefined {
  const warning = parseJson<SchedulerLoopStallWarning>(warningPath(runPath));
  const heartbeat = parseJson<SchedulerHeartbeatRecord>(heartbeatPath(runPath));
  if (!warning || warning.version !== 1 || warning.kind !== 'scheduler_loop_stall' || warning.active !== true) {
    return undefined;
  }
  if (!heartbeat || heartbeat.version !== 1
      || heartbeat.runId !== warning.runId
      || heartbeat.pid !== warning.pid
      || heartbeat.generation !== warning.generation) return undefined;
  if (!isLiveFlowcrewSchedulerForRun(heartbeat.pid, heartbeat.runId, runPath)) return undefined;
  if (!isRunningRunStatus(readRunStatus(runPath) ?? '')) return undefined;
  return warning;
}

export type SchedulerHeartbeatObservation =
  | 'healthy'
  | 'stalled'
  | 'unsupported'
  | 'inactive'
  | 'identity_mismatch';

/** One observer poll, exported so controls can exercise every refusal branch. */
export function observeSchedulerHeartbeatOnce(input: {
  runPath: string;
  runId: string;
  thresholdMs: number;
  nowMs?: number;
}): SchedulerHeartbeatObservation {
  const nowMs = input.nowMs ?? Date.now();
  const heartbeat = parseJson<SchedulerHeartbeatRecord>(heartbeatPath(input.runPath));
  if (!heartbeat || heartbeat.version !== 1) return 'unsupported';
  if (heartbeat.runId !== input.runId || heartbeat.state !== 'running') return 'inactive';
  if (!isLiveFlowcrewSchedulerForRun(heartbeat.pid, input.runId, input.runPath)) {
    return 'identity_mismatch';
  }
  const status = readRunStatus(input.runPath);
  if (!status || !isRunningRunStatus(status)) {
    return 'inactive';
  }
  const updatedAtMs = Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs > nowMs + 5_000) return 'inactive';

  const existing = parseJson<SchedulerLoopStallWarning>(warningPath(input.runPath));
  if (nowMs - updatedAtMs < input.thresholdMs) {
    if (existing?.active === true
        && existing.runId === input.runId
        && existing.pid === heartbeat.pid
        && existing.generation === heartbeat.generation) {
      const recoveredAt = new Date(nowMs).toISOString();
      atomicJson(warningPath(input.runPath), {
        ...existing,
        active: false,
        recoveredAt,
        clearedReason: 'heartbeat advanced',
      } satisfies SchedulerLoopStallWarning);
      appendRunEventAtRunDir(input.runPath, {
        type: 'scheduler_loop_recovered',
        runId: input.runId,
        timestamp: recoveredAt,
        detectedAt: existing.detectedAt,
        detail: `scheduler heartbeat recovered at sequence ${heartbeat.sequence}`,
        source: 'scheduler',
        level: 'info',
      });
    }
    return 'healthy';
  }

  if (existing?.active === true
      && existing.runId === input.runId
      && existing.pid === heartbeat.pid
      && existing.generation === heartbeat.generation) return 'stalled';

  const detectedAt = new Date(nowMs).toISOString();
  const warning: SchedulerLoopStallWarning = {
    version: 1,
    kind: 'scheduler_loop_stall',
    runId: input.runId,
    pid: heartbeat.pid,
    generation: heartbeat.generation,
    active: true,
    detectedAt,
    lastHeartbeatAt: heartbeat.updatedAt,
    lastSequence: heartbeat.sequence,
    thresholdMs: input.thresholdMs,
  };
  atomicJson(warningPath(input.runPath), warning);
  appendRunEventAtRunDir(input.runPath, {
    type: 'scheduler_loop_stalled',
    runId: input.runId,
    timestamp: detectedAt,
    detectedAt,
    detail: `live scheduler pid ${heartbeat.pid} did not advance heartbeat sequence ${heartbeat.sequence} for ${nowMs - updatedAtMs}ms`,
    source: 'scheduler',
    level: 'warning',
  });
  return 'stalled';
}

export interface SchedulerHeartbeatHandle {
  readonly generation: string;
  readonly observerThreadId?: number;
  pulse(): void;
  stop(): void;
}

export function startSchedulerHeartbeat(input: {
  runPath: string;
  runId: string;
  intervalMs: number;
  stallThresholdMs: number;
  observerPollMs: number;
  spawnObserver?: boolean;
}): SchedulerHeartbeatHandle {
  const generation = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  let sequence = 0;
  let stopped = false;
  let observer: Worker | undefined;
  const publish = (state: SchedulerHeartbeatRecord['state']): void => {
    sequence += 1;
    atomicJson(heartbeatPath(input.runPath), {
      version: 1,
      runId: input.runId,
      pid: process.pid,
      generation,
      sequence,
      startedAt,
      updatedAt: new Date().toISOString(),
      state,
    } satisfies SchedulerHeartbeatRecord);
  };
  publish('running');

  const existing = parseJson<SchedulerLoopStallWarning>(warningPath(input.runPath));
  if (existing?.active === true) {
    atomicJson(warningPath(input.runPath), {
      ...existing,
      active: false,
      recoveredAt: startedAt,
      clearedReason: 'new scheduler heartbeat generation claimed the run',
    } satisfies SchedulerLoopStallWarning);
  }

  const timer = setInterval(() => publish('running'), input.intervalMs);
  timer.unref();
  if (input.spawnObserver !== false) {
    // Production executes this module from dist. Source-driven development and
    // tests use the build manifest's matching compiled module because Node's
    // worker loader does not apply tsx's `.js` -> `.ts` specifier remapping.
    const observerModuleUrl = import.meta.url.endsWith('.ts')
      ? new URL('../dist/scheduler-heartbeat.js', import.meta.url)
      : new URL(import.meta.url);
    observer = new Worker(observerModuleUrl, {
      // The compiled observer needs no loader. In particular, do not inherit
      // `--eval`/`--input-type` or an inspector port from the scheduler.
      execArgv: [],
      workerData: {
        kind: 'flowcrew-scheduler-heartbeat-observer',
        runPath: input.runPath,
        runId: input.runId,
        thresholdMs: input.stallThresholdMs,
        pollMs: input.observerPollMs,
      } satisfies SchedulerHeartbeatObserverWorkerData,
    });
    // The heartbeat remains useful even when the platform refuses the observer
    // worker. Avoid turning that visibility failure into an unhandled scheduler
    // exception; the absent warning is itself distinguishable from a stall.
    observer.on('error', () => {});
    observer.unref();
  }

  return {
    generation,
    get observerThreadId() { return observer?.threadId; },
    pulse: () => {
      if (!stopped) publish('running');
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try { publish('stopped'); } catch { /* the run directory may already be unavailable */ }
      try { void observer?.terminate(); } catch { /* observer also exits when identity disappears */ }
      try { unlinkSync(heartbeatPath(input.runPath)); } catch { /* missing */ }
    },
  };
}

interface SchedulerHeartbeatObserverWorkerData {
  kind: 'flowcrew-scheduler-heartbeat-observer';
  runPath: string;
  runId: string;
  thresholdMs: number;
  pollMs: number;
}

function isSchedulerHeartbeatObserverWorkerData(value: unknown): value is SchedulerHeartbeatObserverWorkerData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SchedulerHeartbeatObserverWorkerData>;
  return candidate.kind === 'flowcrew-scheduler-heartbeat-observer'
    && typeof candidate.runPath === 'string'
    && typeof candidate.runId === 'string'
    && typeof candidate.thresholdMs === 'number'
    && typeof candidate.pollMs === 'number';
}

async function observerMain(args: string[]): Promise<void> {
  const [runPath, runId, thresholdRaw, pollRaw] = args;
  const thresholdMs = Number(thresholdRaw);
  const pollMs = Number(pollRaw);
  if (!runPath || !runId || !Number.isFinite(thresholdMs) || thresholdMs <= 0
      || !Number.isFinite(pollMs) || pollMs <= 0) process.exitCode = 2;
  else {
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    while (!stopping && existsSync(heartbeatPath(runPath))) {
      const observation = observeSchedulerHeartbeatOnce({ runPath, runId, thresholdMs });
      if (observation === 'identity_mismatch' || observation === 'inactive') break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
}

if (process.argv[2] === '--observe') {
  void observerMain(process.argv.slice(3)).catch(() => { process.exitCode = 1; });
} else if (!isMainThread && isSchedulerHeartbeatObserverWorkerData(workerData)) {
  void observerMain([
    workerData.runPath,
    workerData.runId,
    String(workerData.thresholdMs),
    String(workerData.pollMs),
  ]).catch(() => { process.exitCode = 1; });
}
