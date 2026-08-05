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
} from './run-lock.js';

export interface CancellationUnitController {
  isActive(unit: string): Promise<string>;
  stopUnit(unit: string): Promise<void>;
}

export interface RunCancellationOptions {
  registry: TaskRegistry;
  units: CancellationUnitController;
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
}

export interface CancellationObservation {
  unit: string | null;
  unitState: string;
  runReadable: boolean;
  schedulerPid: number | null;
  schedulerAlive: boolean;
  launchInFlight: boolean;
}

export interface CancellationResult {
  ok: boolean;
  status: 'cancelled' | 'cancelling' | 'already-terminal';
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

const STOPPED_UNIT_STATES = new Set(['inactive', 'failed', 'unknown', 'not-found']);

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
  private readonly units: CancellationUnitController;
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
    this.isSchedulerPidAlive = options.isSchedulerPidAlive ?? isLiveFlowcrewSchedulerForRun;
    this.canSignalScheduler = options.canSignalScheduler ?? isLiveFlowcrewSchedulerForRun;
    this.signalScheduler = options.signalScheduler ?? ((pid, signal) => process.kill(pid, signal));
    this.isLaunchInFlight = options.isLaunchInFlight ?? (() => false);
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
    const targetRunId = run?.runId ?? (task ? this.taskRunId(task) : undefined);
    const before = await this.observe(target);
    const taskAlreadyTerminal = task ? !isActiveTaskStatus(task.status) : true;
    const runAlreadyTerminal = run
      ? isTerminalRunStatus(run.state.status)
      : !runBinding;
    if (this.isStopped(before) && taskAlreadyTerminal && runAlreadyTerminal) {
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
    if (task) {
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
      if (targetUnit && !unitStopFailed && !STOPPED_UNIT_STATES.has(current.unitState)) return;
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
        && STOPPED_UNIT_STATES.has(current.unitState)
      );
    };

    const deadline = this.clockMs() + this.timeoutMs;
    while (!stoppedAfterRequest(observation) && this.clockMs() < deadline) {
      await this.delay(Math.min(this.pollMs, Math.max(1, deadline - this.clockMs())));
      observation = await this.observe(target);
      signalLiveScheduler(observation);
      // The first stop can race a unit launch that was already in flight. Once
      // that launch becomes visible, stop the newly-created unit in this same
      // cancellation instead of waiting for the next daemon sweep.
      if (
        targetUnit
        && stopAttemptSettled
        && observation.unitState === 'active'
        && stopAttempts < 3
      ) {
        void dispatchUnitStop();
      }
    }

    if (!stoppedAfterRequest(observation)) {
      const message = this.observationMessage(
        `cancellation still in progress${stopError ? `; ${stopError}` : ''}`,
        observation,
      );
      if (task) {
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

    const completedAt = this.now().toISOString();
    let preservedRunStatus: string | undefined;
    const latestRun = runBinding ? this.readRunTarget(runBinding) : run;
    if (latestRun) {
      const latest = this.readRunTarget(latestRun.binding);
      if (latest) {
        if (isTerminalRunStatus(latest.state.status)) {
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

    if (task) {
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
      status: 'cancelled',
      ...(task ? { taskId: task.id } : {}),
      ...(targetRunId ? { runId: targetRunId } : {}),
      observation,
      message: 'Cancellation confirmed: unit and scheduler process are stopped.',
      ...(preservedRunStatus ? { preservedRunStatus } : {}),
    };
  }

  private async observe(target: CancellationTarget): Promise<CancellationObservation> {
    const unit = target.task?.systemd_unit ?? target.unit ?? null;
    let unitState = 'inactive';
    if (unit) {
      try {
        unitState = await this.units.isActive(unit);
      } catch (error) {
        unitState = `unverified:${error instanceof Error ? error.message : String(error)}`;
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
    const launchIntent = latestRun
      ? readLaunchIntent(latestRun.projectDir, undefined, this.clockMs())
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
    return STOPPED_UNIT_STATES.has(observation.unitState)
      && observation.runReadable
      && !observation.schedulerAlive
      && !observation.launchInFlight;
  }

  private observationMessage(prefix: string, observation: CancellationObservation): string {
    const pid = observation.schedulerPid === null ? 'none' : String(observation.schedulerPid);
    return `${prefix}; unit=${observation.unitState}; run_readable=${observation.runReadable}; scheduler pid=${pid} alive=${observation.schedulerAlive}; launch_in_flight=${observation.launchInFlight}`;
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
        if (!isTerminalRunStatus(state.status)) mutateCancelledRun(state, completedAt);
      });
      return;
    }
    const state = JSON.parse(readFileSync(join(run.runPath, 'run.json'), 'utf-8')) as StoreState;
    if (!isTerminalRunStatus(state.status)) {
      mutateCancelledRun(state, completedAt);
      atomicWrite(join(run.runPath, 'run.json'), JSON.stringify(state, null, 2));
    }
  }
}
