import { cancelRunStateAtPath } from './scheduler/sched_policy/run-completion.js';
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
  isTerminalRunStatus,
  resolveRunStatus,
  RUN_STATUS,
  runsRoot,
  type StoreState,
} from './store.js';
import { requireSafeRunId, resolveRunIdentity } from './cancellation-policy.js';
import {
  invalidateRunLockCache,
  isLiveFlowcrewSchedulerForRun,
  parseSchedulerPidMarker,
  readLaunchIntent,
  releaseLaunchIntent,
  schedulerProcessIsAliveForCancellation,
} from './run-lock.js';
import type { SupervisorBackend, UnitStatus } from './supervision.js';
import { checkpointConsumers } from './restart-recovery.js';

/** Blocked recovery ends the workflow without asserting consumer death. An
 * explicit interrupt still closes control state and attempts owned cleanup. */
function preservesTerminalRun(state: StoreState): boolean {
  return isTerminalRunStatus(state.status)
    && !(state.status === RUN_STATUS.FAILED && state.recovery?.kind === 'blocked');
}

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
}

export interface CancellationObservation {
  unit: string | null;
  unitState: UnitStatus;
  runReadable: boolean;
  schedulerPid: number | null;
  schedulerAlive: boolean;
  launchInFlight: boolean;
  activeCommandPids?: number[];
  commandFateKnown?: boolean;
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

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * One control-plane implementation for every external run cancellation.
 * The durable operator decision fences publication before bounded owned cleanup.
 * Observations report execution evidence; they cannot veto that decision.
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
    // evidence and must remain visible in the cancellation observation.
    this.isSchedulerPidAlive = options.isSchedulerPidAlive ?? schedulerProcessIsAliveForCancellation;
    this.canSignalScheduler = options.canSignalScheduler ?? isLiveFlowcrewSchedulerForRun;
    this.signalScheduler = options.signalScheduler ?? ((pid, signal) => process.kill(pid, signal));
    this.isLaunchInFlight = options.isLaunchInFlight ?? (() => false);
  }

  cancelTask(taskId: number): Promise<CancellationResult> {
    const task = this.registry.get(taskId);
    if (!task) throw Object.assign(new Error(`Task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
    const run = this.readRunTarget(task.run_id);
    return this.coordinate({ task, run, runBinding: run?.binding ?? task.run_id });
  }

  cancelRun(runId: string, unit?: string): Promise<CancellationResult> {
    requireSafeRunId(runId);
    const run = this.readRunTarget(runId);
    if (!run) throw Object.assign(new Error(`Run not found: ${runId}`), { code: 'RUN_NOT_FOUND' });
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
    const operation = this.cancelAndCleanUp(target).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async cancelAndCleanUp(initial: CancellationTarget): Promise<CancellationResult> {
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
      ? preservesTerminalRun(run.state)
      : !runBinding;
    const lifecycleAlreadyTerminal = run
      ? runAlreadyTerminal
      : !runBinding && taskAlreadyTerminal;
    // Registry terminal metadata is evidence, not scratch space for the stop
    // protocol. Even if its bound run is unreadable or still needs stopping,
    // cancellation must never erase the task's terminal status/completed_at.
    const preserveTerminalTask = Boolean(task && taskAlreadyTerminal);
    const preservedTaskResultStatus = task?.status === TASK_STATUS.CANCELLED
      ? 'cancelled' as const
      : 'already-terminal' as const;
    // An archived run verdict does not settle queued work or an unfinished
    // cancellation. Those active task intents must close and clear the queue,
    // even when the run itself remains terminal.
    const taskNeedsSettlement = task && !taskAlreadyTerminal;
    // A continuation can claim an owner while its archived verdict is still
    // terminal. Attempt cleanup before preserving that verdict.
    if (lifecycleAlreadyTerminal && this.isStopped(before) && !taskNeedsSettlement) {
      return {
        ok: true,
        status: preservedTaskResultStatus,
        ...(task ? { taskId: task.id } : {}),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(run ? { preservedRunStatus: run.state.status } : {}),
        observation: before,
        message: 'Execution was already terminal; terminal state was preserved.',
      };
    }
    const requestedAt = this.now().toISOString();
    if (task && !preserveTerminalTask) {
      this.registry.update(task.id, {
        status: TASK_STATUS.CANCELLING,
        completed_at: undefined,
        notes: 'cancellation requested; attempting owned process cleanup',
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
    const recordRunDecision = (current: RunTarget | undefined): string | undefined => {
      if (!current) return undefined;
      try { return this.updateRun(current, requestedAt); }
      catch (error) {
        if (!task) throw error; // An unregistered run has no alternate durable decision record.
        const detail = error instanceof Error ? error.message : String(error);
        stopError = stopError ? `${stopError}; run settlement: ${detail}` : `run settlement: ${detail}`;
        return undefined;
      }
    };
    const preservedRunStatus = recordRunDecision(run);
    const targetUnit = (task ? this.registry.get(task.id)?.systemd_unit : undefined)
      ?? task?.systemd_unit ?? target.unit;
    let unitStopFailed = false;
    let stopAttemptSettled = true;
    let stopAttempts = 0;
    const dispatchUnitStop = async (): Promise<void> => {
      if (!targetUnit) return;
      stopAttempts += 1;
      stopAttemptSettled = false;
      try { await this.units.stopUnit(targetUnit); }
      catch (error) {
        unitStopFailed = true;
        const detail = error instanceof Error ? error.message : String(error);
        stopError = stopError ? `${stopError}; unit stop: ${detail}` : `unit stop: ${detail}`;
      } finally { stopAttemptSettled = true; }
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
    const stopOwnedExecution = (current: CancellationObservation): void => {
      try {
        // Detached command groups can survive a portable unit's scheduler stop.
        // Use the same checkpoint proof as recovery, after the controller closes.
        if (!current.schedulerAlive && unitIsStopped(current.unitState)) {
          const latest = runBinding ? this.readRunTarget(runBinding) : run;
          const checkpoint = latest?.state.engineCheckpoint;
          if (checkpoint && latest && checkpoint.runId === latest.runId
              && typeof checkpoint.projectDir === 'string' && resolve(checkpoint.projectDir) === resolve(latest.projectDir)) {
            checkpointConsumers(checkpoint, { retire: true });
          }
        }
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
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        stopError = stopError ? `${stopError}; owned cleanup: ${detail}` : `owned cleanup: ${detail}`;
      }
    };

    let observation = await this.observe(target);
    stopOwnedExecution(observation);
    const deadline = this.clockMs() + this.timeoutMs;
    while (!this.isStopped(observation) && this.clockMs() < deadline) {
      await this.delay(Math.min(this.pollMs, Math.max(1, deadline - this.clockMs())));
      observation = await this.observe(target);
      stopOwnedExecution(observation);
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

    const completedAt = this.now().toISOString();
    const latestRun = runBinding ? this.readRunTarget(runBinding) : run;
    // The same decision fences a run that initialized during owned cleanup.
    recordRunDecision(latestRun);
    const releaseProjectDir = latestRun?.projectDir ?? run?.projectDir ?? task?.projectDir;
    const releaseRunId = latestRun?.runId ?? targetRunId;
    if (releaseProjectDir && releaseRunId) {
      try { releaseLaunchIntent(releaseProjectDir, releaseRunId); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        stopError = stopError ? `${stopError}; launch cleanup: ${detail}` : `launch cleanup: ${detail}`;
      }
    }
    invalidateRunLockCache();
    const message = this.observationMessage(
      `Cancellation recorded${preservedRunStatus ? '; archived run lifecycle was preserved' : ''}${stopError ? `; ${stopError}` : ''}`,
      observation,
    );
    if (task && !preserveTerminalTask) {
      this.registry.update(task.id, {
        status: TASK_STATUS.CANCELLED,
        completed_at: completedAt,
        notes: message,
        not_before: undefined,
        defer_reason: undefined,
        defer_kind: undefined,
      });
      this.registry.appendTick(task.id, {
        ts: completedAt,
        status: TASK_STATUS.CANCELLED,
        message,
      });
    }

    return {
      ok: true,
      status: preserveTerminalTask ? preservedTaskResultStatus : 'cancelled',
      ...(task ? { taskId: task.id } : {}),
      ...(targetRunId ? { runId: targetRunId } : {}),
      observation,
      message,
      ...(preservedRunStatus ? { preservedRunStatus } : {}),
    };
  }

  private async observe(target: CancellationTarget): Promise<CancellationObservation> {
    const unit = (target.task ? this.registry.get(target.task.id)?.systemd_unit : undefined)
      ?? target.task?.systemd_unit ?? target.unit ?? null;
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
    let activeCommandPids: number[] = [];
    let commandFateKnown = false;
    try {
      activeCommandPids = checkpointConsumers(latestRun?.state.engineCheckpoint);
      commandFateKnown = true;
    } catch { /* invalid or unreadable ownership is unknown evidence */ }
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
      ...(activeCommandPids.length ? { activeCommandPids } : {}),
      ...(!commandFateKnown ? { commandFateKnown: false } : {}),
    };
  }

  private isStopped(observation: CancellationObservation): boolean {
    return unitIsStopped(observation.unitState)
      && observation.runReadable
      && !observation.schedulerAlive
      && !observation.launchInFlight
      && observation.commandFateKnown !== false
      && !observation.activeCommandPids?.length;
  }

  private observationMessage(prefix: string, observation: CancellationObservation): string {
    const pid = observation.schedulerPid === null ? 'none' : String(observation.schedulerPid);
    return `${prefix}; unit=${describeUnitStatus(observation.unitState)}; run_readable=${observation.runReadable}; scheduler pid=${pid} alive=${observation.schedulerAlive}; launch_in_flight=${observation.launchInFlight}`
      + (observation.activeCommandPids?.length ? `; active command groups=${observation.activeCommandPids.length}` : '')
      + (observation.commandFateKnown === false ? '; command fate is unknown' : '');
  }

  private taskRunId(task: TaskEntry): string | undefined {
    if (!task.run_id) return undefined;
    return this.readRunTarget(task.run_id)?.runId ?? (isAbsolute(task.run_id) ? basename(task.run_id) : task.run_id);
  }

  private readRunTarget(runIdOrPath: string | undefined): RunTarget | undefined {
    if (!runIdOrPath) return undefined;
    try {
      if (!isAbsolute(runIdOrPath)) requireSafeRunId(runIdOrPath);
      const identity = resolveRunIdentity(isAbsolute(runIdOrPath) ? resolve(runIdOrPath) : join(this.runsDir, runIdOrPath), isAbsolute(runIdOrPath) ? undefined : this.runsDir);
      const runPath = identity.directory;
      const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as StoreState;
      if (!state || typeof state.projectDir !== 'string' || typeof state.status !== 'string') return undefined;
      const status = resolveRunStatus(state.status);
      if (status.kind === 'known') state.status = status.status;
      const runId = identity.runId;
      return { runId, binding: runPath, runPath, projectDir: state.projectDir, state };
    } catch {
      // Unavailable evidence cannot grant run control or veto the task decision.
      return undefined;
    }
  }

  private updateRun(run: RunTarget, completedAt: string): string | undefined {
    return cancelRunStateAtPath(run.runPath, completedAt).preservedRunStatus;
  }
}
