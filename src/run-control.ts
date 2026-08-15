import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  isActiveTaskStatus,
  TASK_LIST_STATUS,
  TASK_STATUS,
  type TaskEntry,
  type TaskRegistry,
} from './task-registry.js';
import {
  atomicWrite,
  isPendingStageStatus,
  isRunningStageStatus,
  isTerminalRunStatus,
  requireKnownRunStatus,
  resolveRunStatus,
  RUN_STATUS,
  runsRoot,
  STAGE_STATUS,
  updateRunState,
  type StoreState,
} from './store.js';
import {
  invalidateRunLockCache,
  isLiveFlowcrewSchedulerForRun,
  parseSchedulerPidMarker,
  readLaunchIntent,
  releaseLaunchIntent,
  schedulerProcessIsAliveForCancellation,
} from './run-lock.js';
import type { SupervisorBackend, UnitStatus } from './supervision.js';

export interface RunCancellationOptions {
  registry: TaskRegistry;
  units: SupervisorBackend;
  /** Override for a control client whose selected socket owns an isolated state root. */
  runsDir?: string;
  now?: () => Date;
  clockMs?: () => number;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  signalGraceMs?: number;
  isSchedulerPidAlive?: (pid: number, runId: string, runPath: string) => boolean;
  canSignalScheduler?: (pid: number, runId: string, runPath: string) => boolean;
  signalScheduler?: (pid: number, signal: NodeJS.Signals) => void;
  isLaunchInFlight?: (taskId: number) => boolean;
  maxUnobservableObservations?: number;
  maxUnobservableDurationMs?: number;
}

export interface CancellationObservation {
  unit: string | null;
  unitState: UnitStatus;
  runReadable: boolean;
  schedulerPid: number | null;
  schedulerAlive: boolean;
  launchInFlight: boolean;
}

export interface CancellationResult {
  ok: boolean;
  status: 'cancelled' | 'cancelling' | 'already-terminal' | 'outcome-unknown';
  taskId?: number;
  runId?: string;
  observation: CancellationObservation;
  message: string;
  preservedRunStatus?: string;
}

interface RunTarget {
  runId: string;
  binding: string;
  runPath: string;
  projectDir: string;
  state: StoreState;
}

interface CancellationTarget {
  task?: TaskEntry;
  run?: RunTarget;
  runBinding?: string;
  unit?: string;
}

const DEFAULT_MAX_UNOBSERVABLE_OBSERVATIONS = 10;
const DEFAULT_MAX_UNOBSERVABLE_DURATION_MS = 5 * 60_000;
const CANCELLATION_OBSERVATION_FILE = 'cancellation-observation.json';

interface CancellationObservationBudget {
  version: 1;
  count: number;
  firstObservedAt: string;
  lastReason: string;
  limitedAt?: string;
}

export function unitIsStopped(status: UnitStatus): boolean {
  switch (status.kind) {
    case 'terminal':
    case 'terminal-unknown':
    case 'absent':
      return true;
    case 'active':
    case 'deactivating':
    case 'unobservable':
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function unitOwnsGracefulStop(status: UnitStatus): boolean {
  switch (status.kind) {
    case 'active':
    case 'deactivating':
      return true;
    case 'terminal':
    case 'terminal-unknown':
    case 'absent':
    case 'unobservable':
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function describeUnitStatus(status: UnitStatus): string {
  switch (status.kind) {
    case 'active':
    case 'deactivating':
    case 'absent':
      return status.kind;
    case 'terminal':
      return status.signal
        ? `terminal(exit=${status.exitCode}, signal=${status.signal})`
        : `terminal(exit=${status.exitCode})`;
    case 'terminal-unknown':
      return `outcome unknown (${status.reason})`;
    case 'unobservable':
      return `unobservable(${status.reason})`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class CancellationObservationLimitError extends Error {
  readonly code = 'FLOWCREW_CANCELLATION_OBSERVATION_LIMIT';
  readonly unit: string | null;
  readonly observations: number;

  constructor(unit: string | null, observations: number, reason: string, action: string) {
    super(
      `Cancellation observation limit reached for ${unit ?? 'detached run'} after ${observations} `
      + `consecutive nonterminal checks (${reason}). Automatic retries stopped; ${action}`,
    );
    this.name = 'CancellationObservationLimitError';
    this.unit = unit;
    this.observations = observations;
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function safeRunId(runId: string): boolean {
  return runId.length > 0 && !runId.includes('..') && !runId.includes('/') && !runId.includes('\\');
}

function mutateCancelledRun(state: StoreState, completedAt: string): void {
  state.status = RUN_STATUS.STOPPED;
  state.failureReason = 'Cancelled by user';
  state.completedAt = completedAt;
  for (const stage of Object.values(state.stages)) {
    if (isRunningStageStatus(stage.status)) stage.status = STAGE_STATUS.FAILED;
    if (isPendingStageStatus(stage.status)) stage.status = STAGE_STATUS.SKIPPED;
  }
}

/**
 * One control-plane implementation for every external run cancellation.
 * Terminal records are written only after both the unit and scheduler PID are
 * confirmed stopped. Repeated callers join the same in-flight operation.
 */
export class RunCancellationCoordinator {
  private readonly registry: TaskRegistry;
  private readonly units: SupervisorBackend;
  private readonly runsDir: string;
  private readonly now: () => Date;
  private readonly clockMs: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly signalGraceMs: number;
  private readonly isSchedulerPidAlive: (pid: number, runId: string, runPath: string) => boolean;
  private readonly canSignalScheduler: (pid: number, runId: string, runPath: string) => boolean;
  private readonly signalScheduler: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isLaunchInFlight: (taskId: number) => boolean;
  private readonly maxUnobservableObservations: number;
  private readonly maxUnobservableDurationMs: number;
  private readonly inFlight = new Map<string, Promise<CancellationResult>>();

  constructor(options: RunCancellationOptions) {
    this.registry = options.registry;
    this.units = options.units;
    this.runsDir = resolve(options.runsDir ?? runsRoot());
    this.now = options.now ?? (() => new Date());
    this.clockMs = options.clockMs ?? Date.now;
    this.delay = options.delay ?? defaultDelay;
    this.timeoutMs = Math.max(0, options.timeoutMs ?? 1_500);
    this.pollMs = Math.max(10, options.pollMs ?? 50);
    this.signalGraceMs = Math.max(0, options.signalGraceMs ?? 100);
    // Liveness and authority to signal are deliberately separate. An unreadable
    // start token makes the process unbound, but EPERM/token failure is not death
    // evidence and must not open the schedulerAlive cancellation barrier.
    this.isSchedulerPidAlive = options.isSchedulerPidAlive ?? schedulerProcessIsAliveForCancellation;
    this.canSignalScheduler = options.canSignalScheduler ?? isLiveFlowcrewSchedulerForRun;
    this.signalScheduler = options.signalScheduler ?? ((pid, signal) => process.kill(pid, signal));
    this.isLaunchInFlight = options.isLaunchInFlight ?? (() => false);
    this.maxUnobservableObservations = Math.max(
      1,
      options.maxUnobservableObservations ?? DEFAULT_MAX_UNOBSERVABLE_OBSERVATIONS,
    );
    this.maxUnobservableDurationMs = Math.max(
      1,
      options.maxUnobservableDurationMs ?? DEFAULT_MAX_UNOBSERVABLE_DURATION_MS,
    );
  }

  cancelTask(taskId: number): Promise<CancellationResult> {
    const task = this.registry.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return this.coordinate({ task, run: this.readRunTarget(task.run_id), runBinding: task.run_id });
  }

  cancelRun(runId: string, unit?: string): Promise<CancellationResult> {
    if (!safeRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
    const run = this.readRunTarget(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const task = this.registry.list({ status: TASK_LIST_STATUS.ALL })
      .filter((entry) => this.taskRunId(entry) === run.runId)
      .sort((left, right) => (
        Number(isActiveTaskStatus(right.status)) - Number(isActiveTaskStatus(left.status))
        || right.id - left.id
      ))[0];
    return this.coordinate({ task, run, runBinding: run.binding, unit });
  }

  private coordinate(target: CancellationTarget): Promise<CancellationResult> {
    const boundRunId = target.run?.runId
      ?? (target.runBinding
        ? (isAbsolute(target.runBinding) ? basename(target.runBinding) : target.runBinding)
        : undefined);
    const key = boundRunId ? `run:${boundRunId}` : `task:${target.task!.id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.cancelAndConfirm(target).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async cancelAndConfirm(initial: CancellationTarget): Promise<CancellationResult> {
    const task = initial.task ? (this.registry.get(initial.task.id) ?? initial.task) : undefined;
    const runBinding = initial.runBinding ?? initial.run?.binding ?? task?.run_id;
    const run = runBinding
      ? (this.readRunTarget(runBinding) ?? initial.run)
      : initial.run;
    const target: CancellationTarget = { task, run, runBinding, unit: initial.unit };
    this.throwIfObservationLimitReached(target);
    const targetRunId = run?.runId ?? (task ? this.taskRunId(task) : undefined);
    const before = await this.observe(target);
    if (before.unitState.kind === 'terminal-unknown') {
      return this.outcomeUnknown(target, before);
    }
    const taskAlreadyTerminal = task ? !isActiveTaskStatus(task.status) : true;
    const runAlreadyTerminal = run
      ? isTerminalRunStatus(run.state.status)
      : !runBinding;
    // Registry terminal metadata is evidence, not scratch space for the stop
    // protocol. Even if its bound run is unreadable or still needs stopping,
    // cancellation must never erase the task's terminal status/completed_at.
    const preserveTerminalTask = Boolean(task && taskAlreadyTerminal);
    const preservedTaskResultStatus = task?.status === TASK_STATUS.CANCELLED
      ? 'cancelled' as const
      : 'already-terminal' as const;
    if (this.isStopped(before) && taskAlreadyTerminal && runAlreadyTerminal) {
      this.clearObservationBudget(target);
      return {
        ok: true,
        status: task?.status === TASK_STATUS.CANCELLED ? 'cancelled' : 'already-terminal',
        ...(task ? { taskId: task.id } : {}),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(run ? { preservedRunStatus: run.state.status } : {}),
        observation: before,
        message: 'Execution was already stopped; terminal state was preserved.',
      };
    }

    const requestedAt = this.now().toISOString();
    if (task && !preserveTerminalTask) {
      this.registry.update(task.id, {
        status: TASK_STATUS.CANCELLING,
        completed_at: undefined,
        notes: 'cancellation requested; waiting for unit and scheduler process to stop',
        not_before: undefined,
        defer_reason: undefined,
        defer_kind: undefined,
      });
      this.registry.appendTick(task.id, {
        ts: requestedAt,
        status: TASK_STATUS.CANCELLING,
        message: this.observationMessage('stop requested', before),
      });
    }

    let stopError: string | undefined;
    const targetUnit = task?.systemd_unit ?? target.unit;
    let unitStopFailed = false;
    let stopAttemptSettled = true;
    let stopAttempts = 0;
    const dispatchUnitStop = (): Promise<void> => {
      if (!targetUnit) return Promise.resolve();
      stopAttempts += 1;
      stopAttemptSettled = false;
      return this.units.stopUnit(targetUnit)
        .catch((error) => {
          unitStopFailed = true;
          const detail = error instanceof Error ? error.message : String(error);
          stopError = stopError ? `${stopError}; unit stop: ${detail}` : `unit stop: ${detail}`;
        })
        .finally(() => { stopAttemptSettled = true; });
    };
    if (targetUnit) {
      const stopAttempt = dispatchUnitStop();
      // Dispatch the graceful unit stop without allowing a slow systemctl call
      // to hide the observable cancelling transition or defeat the bound.
      await Promise.race([stopAttempt, this.delay(this.signalGraceMs)]);
    } else if (this.signalGraceMs > 0) {
      await this.delay(this.signalGraceMs);
    }

    const handledPids = new Set<number>();
    const signalLiveScheduler = (current: CancellationObservation): void => {
      if (
        !current.schedulerAlive
        || current.schedulerPid === null
        || !targetRunId
        || handledPids.has(current.schedulerPid)
      ) return;
      // systemd owns the graceful stop when a unit is still deactivating. The
      // PID fallback is for a failed unit stop, an escaped scheduler after the
      // unit stopped, or a detached run with no unit at all.
      if (targetUnit && !unitStopFailed && unitOwnsGracefulStop(current.unitState)) return;
      handledPids.add(current.schedulerPid);
      const latestRun = runBinding ? this.readRunTarget(runBinding) : run;
      if (
        latestRun
        && this.canSignalScheduler(current.schedulerPid, targetRunId, latestRun.runPath)
      ) {
        try {
          this.signalScheduler(current.schedulerPid, 'SIGTERM');
          if (task) {
            this.registry.appendTick(task.id, {
              status: TASK_STATUS.CANCELLING,
              message: `graceful stop left scheduler pid ${current.schedulerPid} alive; sent SIGTERM fallback`,
            });
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          stopError = stopError ? `${stopError}; SIGTERM: ${detail}` : `SIGTERM: ${detail}`;
        }
      } else {
        const detail = `scheduler pid ${current.schedulerPid} is live but its command is not bound to run ${targetRunId}; refusing to signal it`;
        stopError = stopError ? `${stopError}; ${detail}` : detail;
      }
    };

    let observation = await this.observe(target);
    if (observation.unitState.kind === 'terminal-unknown') {
      return this.outcomeUnknown(target, observation);
    }
    signalLiveScheduler(observation);
    const stoppedAfterRequest = (current: CancellationObservation): boolean => {
      if (this.isStopped(current)) return true;
      // A registered launch can be cancelled after its unit was created but
      // before the child initialized run.json. Once the graceful unit stop has
      // settled, the unit is confirmed stopped, and the orchestrator launch is
      // no longer in flight, that absent run cannot later grow a scheduler.
      return Boolean(
        task
        && runBinding
        && targetUnit
        && stopAttempts > 0
        && stopAttemptSettled
        && !unitStopFailed
        && !this.isLaunchInFlight(task.id)
        && !current.runReadable
        && !current.schedulerAlive
        && unitIsStopped(current.unitState)
      );
    };

    const deadline = this.clockMs() + this.timeoutMs;
    while (!stoppedAfterRequest(observation) && this.clockMs() < deadline) {
      await this.delay(Math.min(this.pollMs, Math.max(1, deadline - this.clockMs())));
      observation = await this.observe(target);
      if (observation.unitState.kind === 'terminal-unknown') {
        return this.outcomeUnknown(target, observation);
      }
      signalLiveScheduler(observation);
      // The first stop can race a unit launch that was already in flight. Once
      // that launch becomes visible, stop the newly-created unit in this same
      // cancellation instead of waiting for the next daemon sweep.
      if (
        targetUnit
        && stopAttemptSettled
        && observation.unitState.kind === 'active'
        && stopAttempts < 3
      ) {
        void dispatchUnitStop();
      }
    }

    if (!stoppedAfterRequest(observation)) {
      this.recordObservationBudget(target, observation);
      const message = this.observationMessage(
        `cancellation still in progress${stopError ? `; ${stopError}` : ''}`,
        observation,
      );
      if (task && !preserveTerminalTask) {
        this.registry.update(task.id, { status: TASK_STATUS.CANCELLING, notes: message });
        this.registry.appendTick(task.id, { status: TASK_STATUS.CANCELLING, message });
      }
      return {
        ok: false,
        status: 'cancelling',
        ...(task ? { taskId: task.id } : {}),
        ...(targetRunId ? { runId: targetRunId } : {}),
        observation,
        message,
      };
    }

    this.clearObservationBudget(target);
    const completedAt = this.now().toISOString();
    let preservedRunStatus: string | undefined;
    let unrecognizedRunStatusReason: string | undefined;
    const latestRun = runBinding ? this.readRunTarget(runBinding) : run;
    if (latestRun) {
      const latest = this.readRunTarget(latestRun.binding);
      if (latest) {
        const statusResolution = resolveRunStatus(latest.state.status);
        if (statusResolution.kind === 'unknown') {
          preservedRunStatus = typeof latest.state.status === 'string'
            ? latest.state.status
            : statusResolution.display;
          unrecognizedRunStatusReason = statusResolution.reason;
        } else if (isTerminalRunStatus(statusResolution.status)) {
          preservedRunStatus = latest.state.status;
        } else {
          this.updateRun(latest, completedAt);
        }
      }
    }
    const releaseProjectDir = latestRun?.projectDir ?? run?.projectDir ?? task?.projectDir;
    const releaseRunId = latestRun?.runId ?? targetRunId;
    if (releaseProjectDir && releaseRunId) releaseLaunchIntent(releaseProjectDir, releaseRunId);
    invalidateRunLockCache();
    if (!observation.runReadable && observation.launchInFlight) {
      observation = { ...observation, launchInFlight: false };
    }

    if (task && !preserveTerminalTask) {
      this.registry.update(task.id, {
        status: TASK_STATUS.CANCELLED,
        completed_at: completedAt,
        notes: 'cancelled by operator after unit and scheduler process stopped',
        not_before: undefined,
        defer_reason: undefined,
        defer_kind: undefined,
      });
      this.registry.appendTick(task.id, {
        ts: completedAt,
        status: TASK_STATUS.CANCELLED,
        message: this.observationMessage('stop confirmed', observation),
      });
    }

    return {
      ok: true,
      status: preserveTerminalTask ? preservedTaskResultStatus : 'cancelled',
      ...(task ? { taskId: task.id } : {}),
      ...(targetRunId ? { runId: targetRunId } : {}),
      observation,
      message: preserveTerminalTask
        ? 'Execution was already terminal; stop was confirmed and terminal state was preserved.'
        : unrecognizedRunStatusReason
          ? `Cancellation confirmed: unit and scheduler process are stopped; run lifecycle was preserved because ${unrecognizedRunStatusReason}.`
          : 'Cancellation confirmed: unit and scheduler process are stopped.',
      ...(preservedRunStatus ? { preservedRunStatus } : {}),
    };
  }

  private outcomeUnknown(
    target: CancellationTarget,
    observation: CancellationObservation,
  ): CancellationResult {
    const reason = observation.unitState.kind === 'terminal-unknown'
      ? observation.unitState.reason
      : 'supervisor status was lost';
    const message = `Cancellation outcome unknown (${reason}); one or more processes may still be running. Inspect task status and logs before intervening manually.`;
    const task = target.task ? (this.registry.get(target.task.id) ?? target.task) : undefined;
    if (task && isActiveTaskStatus(task.status)) {
      const observedAt = this.now().toISOString();
      this.registry.update(task.id, {
        status: TASK_STATUS.STUCK,
        completed_at: observedAt,
        notes: message,
        not_before: undefined,
        defer_reason: undefined,
        defer_kind: undefined,
      });
      this.registry.appendTick(task.id, {
        ts: observedAt,
        status: TASK_STATUS.STUCK,
        message,
      });
    }
    this.clearObservationBudget(target);
    const runId = target.run?.runId
      ?? (target.runBinding
        ? (isAbsolute(target.runBinding) ? basename(target.runBinding) : target.runBinding)
        : undefined);
    return {
      ok: false,
      status: 'outcome-unknown',
      ...(task ? { taskId: task.id } : {}),
      ...(runId ? { runId } : {}),
      observation,
      message,
    };
  }

  private throwIfObservationLimitReached(target: CancellationTarget): void {
    const budget = this.readObservationBudget(target);
    if (!budget?.limitedAt) return;
    throw this.observationLimitError(target, budget);
  }

  private recordObservationBudget(
    target: CancellationTarget,
    observation: CancellationObservation,
  ): void {
    // This method is reached only after the full stop predicate failed. Count
    // every such observation, including persistently active/deactivating units,
    // so no observation state can create an infinite cancellation retry loop.
    const previous = this.readObservationBudget(target);
    const observedAt = this.now().toISOString();
    const firstObservedAt = previous?.count ? previous.firstObservedAt : observedAt;
    const count = (previous?.count ?? 0) + 1;
    const firstMs = Date.parse(firstObservedAt);
    const observedMs = Date.parse(observedAt);
    const durationExceeded = Number.isFinite(firstMs)
      && Number.isFinite(observedMs)
      && observedMs - firstMs >= this.maxUnobservableDurationMs;
    const limited = count >= this.maxUnobservableObservations || durationExceeded;
    const budget: CancellationObservationBudget = {
      version: 1,
      count,
      firstObservedAt,
      lastReason: describeUnitStatus(observation.unitState),
      ...(limited ? { limitedAt: observedAt } : {}),
    };
    this.writeObservationBudget(target, budget);
    if (!limited) return;

    const error = this.observationLimitError(target, budget);
    const latestTask = target.task ? (this.registry.get(target.task.id) ?? target.task) : undefined;
    if (latestTask && isActiveTaskStatus(latestTask.status)) {
      this.registry.update(latestTask.id, {
        status: TASK_STATUS.STUCK,
        notes: error.message,
        completed_at: undefined,
      });
      this.registry.appendTick(latestTask.id, {
        ts: observedAt,
        status: TASK_STATUS.STUCK,
        message: error.message,
      });
    }
    throw error;
  }

  private observationLimitError(
    target: CancellationTarget,
    budget: CancellationObservationBudget,
  ): CancellationObservationLimitError {
    const unit = target.task?.systemd_unit ?? target.unit ?? null;
    const action = target.task
      ? `run \`flowcrew task show ${target.task.id}\` and \`flowcrew task tail ${target.task.id}\` before intervening manually.`
      : `inspect run ${target.run?.runId ?? target.runBinding ?? 'unknown'} before intervening manually.`;
    return new CancellationObservationLimitError(unit, budget.count, budget.lastReason, action);
  }

  private readObservationBudget(target: CancellationTarget): CancellationObservationBudget | undefined {
    if (target.task) {
      const latest = this.registry.get(target.task.id) ?? target.task;
      const count = latest.cancellation_unobservable_count;
      if (!Number.isInteger(count) || (count ?? 0) <= 0) return undefined;
      return {
        version: 1,
        count: count!,
        firstObservedAt: latest.cancellation_unobservable_first_at ?? latest.created_at,
        lastReason: latest.cancellation_unobservable_reason ?? 'unknown supervisor observation',
        ...(latest.cancellation_observation_limit_reached_at
          ? { limitedAt: latest.cancellation_observation_limit_reached_at }
          : {}),
      };
    }
    const runPath = target.run?.runPath;
    if (!runPath) return undefined;
    try {
      const parsed = JSON.parse(
        readFileSync(join(runPath, CANCELLATION_OBSERVATION_FILE), 'utf-8'),
      ) as Partial<CancellationObservationBudget>;
      if (parsed.version !== 1 || !Number.isInteger(parsed.count) || (parsed.count ?? 0) <= 0) return undefined;
      if (typeof parsed.firstObservedAt !== 'string' || typeof parsed.lastReason !== 'string') return undefined;
      return parsed as CancellationObservationBudget;
    } catch {
      return undefined;
    }
  }

  private writeObservationBudget(
    target: CancellationTarget,
    budget: CancellationObservationBudget | undefined,
  ): void {
    if (target.task) {
      this.registry.update(target.task.id, {
        cancellation_unobservable_count: budget?.count,
        cancellation_unobservable_first_at: budget?.firstObservedAt,
        cancellation_unobservable_reason: budget?.lastReason,
        cancellation_observation_limit_reached_at: budget?.limitedAt,
      });
      return;
    }
    const runPath = target.run?.runPath;
    if (!runPath) return;
    const record = budget ?? {
      version: 1 as const,
      count: 0,
      firstObservedAt: this.now().toISOString(),
      lastReason: '',
    };
    atomicWrite(
      join(runPath, CANCELLATION_OBSERVATION_FILE),
      JSON.stringify(record, null, 2) + '\n',
    );
  }

  private clearObservationBudget(target: CancellationTarget): void {
    if (this.readObservationBudget(target) !== undefined) this.writeObservationBudget(target, undefined);
  }

  private async observe(target: CancellationTarget): Promise<CancellationObservation> {
    const unit = target.task?.systemd_unit ?? target.unit ?? null;
    let unitState: UnitStatus = { kind: 'absent' };
    if (unit) {
      try {
        unitState = await this.units.isActive(unit);
      } catch (error) {
        unitState = {
          kind: 'unobservable',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const expectedRunBinding = target.runBinding ?? target.run?.binding;
    const latestRun = expectedRunBinding ? this.readRunTarget(expectedRunBinding) : target.run;
    let schedulerPid: number | null = null;
    if (latestRun) {
      try {
        schedulerPid = parseSchedulerPidMarker(
          readFileSync(join(latestRun.runPath, 'scheduler.pid'), 'utf-8'),
        );
      } catch { /* scheduler has not claimed the run, or already cleaned up */ }
    }
    const expectedRunId = latestRun?.runId ?? (target.task ? this.taskRunId(target.task) : undefined);
    // A launch intent protects the gap before run.json exists. Once that run is
    // readable, the persisted intent is ownership evidence for admission control,
    // not evidence that another child can still appear. The in-process launch set
    // remains authoritative for the narrower race where runUnit itself has not
    // settled yet. Treating a readable run's intent as launch-in-flight creates a
    // circular cancellation barrier: the killed scheduler cannot release it, while
    // cancellation refuses to release it until the scheduler is confirmed stopped.
    const launchIntent = latestRun
      ? null
      : target.task
        ? readLaunchIntent(target.task.projectDir, undefined, this.clockMs())
        : null;
    return {
      unit,
      unitState,
      runReadable: !expectedRunBinding || Boolean(latestRun),
      schedulerPid,
      schedulerAlive: schedulerPid !== null
        && latestRun !== undefined
        && this.isSchedulerPidAlive(schedulerPid, latestRun.runId, latestRun.runPath),
      launchInFlight: Boolean(
        (target.task && this.isLaunchInFlight(target.task.id))
        || (expectedRunId && launchIntent?.ownerRunId === expectedRunId)
      ),
    };
  }

  private isStopped(observation: CancellationObservation): boolean {
    return unitIsStopped(observation.unitState)
      && observation.runReadable
      && !observation.schedulerAlive
      && !observation.launchInFlight;
  }

  private observationMessage(prefix: string, observation: CancellationObservation): string {
    const pid = observation.schedulerPid === null ? 'none' : String(observation.schedulerPid);
    return `${prefix}; unit=${describeUnitStatus(observation.unitState)}; run_readable=${observation.runReadable}; scheduler pid=${pid} alive=${observation.schedulerAlive}; launch_in_flight=${observation.launchInFlight}`;
  }

  private taskRunId(task: TaskEntry): string | undefined {
    if (!task.run_id) return undefined;
    if (!isAbsolute(task.run_id)) return task.run_id;
    return this.readRunTarget(task.run_id)?.runId ?? basename(task.run_id);
  }

  private readRunTarget(runIdOrPath: string | undefined): RunTarget | undefined {
    if (!runIdOrPath) return undefined;
    const runPath = isAbsolute(runIdOrPath) ? resolve(runIdOrPath) : join(this.runsDir, runIdOrPath);
    try {
      const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as StoreState;
      if (!state || typeof state.projectDir !== 'string' || typeof state.status !== 'string') return undefined;
      const runId = typeof state.runId === 'string' && state.runId ? state.runId : basename(runPath);
      return { runId, binding: runIdOrPath, runPath, projectDir: state.projectDir, state };
    } catch {
      return undefined;
    }
  }

  private updateRun(run: RunTarget, completedAt: string): void {
    const canonicalPath = resolve(join(runsRoot(), run.runId));
    if (canonicalPath === resolve(run.runPath)) {
      updateRunState(run.projectDir, run.runId, (state) => {
        requireKnownRunStatus(state.status, `cancel run ${run.runId}`);
        if (!isTerminalRunStatus(state.status)) mutateCancelledRun(state, completedAt);
      });
      return;
    }
    const state = JSON.parse(readFileSync(join(run.runPath, 'run.json'), 'utf-8')) as StoreState;
    requireKnownRunStatus(state.status, `cancel run ${run.runId}`);
    if (!isTerminalRunStatus(state.status)) {
      mutateCancelledRun(state, completedAt);
      atomicWrite(join(run.runPath, 'run.json'), JSON.stringify(state, null, 2));
    }
  }
}
