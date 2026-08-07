import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  TaskRegistry,
  TASK_LIST_STATUS,
  TASK_STATUS,
  isActiveTaskStatus,
  type TaskCreateInput,
  type TaskEntry,
} from './task-registry.js';
import { parseTaskSummary } from './task-summary-parser.js';
import {
  claimLaunchIntent,
  findParkedRunForProject,
  invalidateRunLockCache,
  isProjectBusy,
  processCommandMatches,
  processIsAlive,
  processStartToken,
  processStartTokensMatch,
  readLaunchIntent,
  releaseLaunchIntent,
  type ProcessStartToken,
} from './run-lock.js';
import {
  isPausedRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  readRunReservation,
  reserveRun,
  RUN_STATUS,
  runsRoot,
} from './store.js';
import { verifyBriefAdmission, type BriefAdmissionRecord } from './brief-preflight.js';
import {
  RunCancellationCoordinator,
  type CancellationResult,
  type RunCancellationOptions,
} from './run-control.js';
import {
  SUPERVISION_PROTOCOL_VERSION,
  atomicWriteJson,
  gcSupervisionDirectories,
  hasSupervisionEvidence,
  observePortableUnit,
  readSupervisionRunning,
  runningRecordBindingStatus,
  supervisionPaths,
  type SupervisorBackend,
  type SupervisorLogSource,
  type SupervisorTailSnapshot,
  type SupervisionExitRecord,
  type SupervisionLaunchRecord,
  type SupervisionRunningRecord,
  type UnitStatus,
} from './supervision.js';

export type { SupervisorBackend, UnitStatus } from './supervision.js';

const execFileAsync = promisify(execFile);
const PORTABLE_BIND_ATTEMPTS = 10;
const PORTABLE_BIND_INTERVAL_MS = 25;

/** Deferred-queue backoff: 30s doubling per attempt, capped at 10 min. */
const DEFER_BASE_MS = 30_000;
const DEFER_MAX_MS = 600_000;
interface BoundRun {
  runId: string;
  path: string;
  status: string;
  failureReason?: string;
}

export interface GitAdapter {
  findCommitByPrefix(projectDir: string, prefix: string): Promise<string | undefined>;
  hasUncommittedChanges(projectDir: string): Promise<boolean>;
  /** Latest commit (HEAD) made on or after isoSince. Undefined if no commit since. */
  findCommitSince(projectDir: string, isoSince: string): Promise<{ sha: string; subject: string } | undefined>;
}

export interface OrchestratorOptions {
  registry?: TaskRegistry;
  systemd?: SupervisorBackend;
  git?: GitAdapter;
  intervalMs?: number;
  cliPath?: string;
  now?: () => Date;
  /** Single-in-flight probe (injectable so tests don't read the real ~/.fc/runs). */
  isProjectBusy?: (projectDir: string, selfRunId?: string, nowMs?: number) => string | null;
  /** Run-id allocator seam used to prove association failures fail closed. */
  reserveRun?: typeof reserveRun;
  /** Bounded cancellation seams; production still supplies registry/unit ownership here. */
  cancellation?: Partial<Omit<
    RunCancellationOptions,
    'registry' | 'units' | 'now' | 'isLaunchInFlight'
  >>;
}

export class Orchestrator {
  readonly registry: TaskRegistry;
  private readonly systemd: SupervisorBackend;
  private readonly git: GitAdapter;
  private readonly intervalMs: number;
  private readonly cliPath: string;
  private readonly now: () => Date;
  private readonly probeBusy: (projectDir: string, selfRunId?: string, nowMs?: number) => string | null;
  private readonly allocateRun: typeof reserveRun;
  private readonly cancellations: RunCancellationCoordinator;
  /** Tasks currently awaiting runUnit(). A tick must not interpret their unit
   *  as inactive and launch or reconcile them a second time. */
  private launchingTaskIds = new Set<number>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private startedAt = Date.now();

  constructor(opts: OrchestratorOptions = {}) {
    this.registry = opts.registry ?? new TaskRegistry();
    this.systemd = opts.systemd ?? new NodeSystemd(this.registry.baseDir);
    this.git = opts.git ?? new NodeGit();
    this.intervalMs = opts.intervalMs ?? 30000;
    this.cliPath = opts.cliPath ?? resolve(import.meta.dirname ?? '.', 'cli.js');
    this.now = opts.now ?? (() => new Date());
    this.probeBusy = opts.isProjectBusy ?? isProjectBusy;
    this.allocateRun = opts.reserveRun ?? reserveRun;
    this.cancellations = new RunCancellationCoordinator({
      ...opts.cancellation,
      registry: this.registry,
      units: this.systemd,
      now: this.now,
      isLaunchInFlight: (taskId) => this.launchingTaskIds.has(taskId),
    });
  }

  /** Busy check that also honors launches not yet visible to the run probe. */
  private busyFor(projectDir: string, selfRunId?: string): string | null {
    const nowMs = this.now().getTime();
    const intent = readLaunchIntent(projectDir, selfRunId, nowMs);
    if (intent) return intent.ownerRunId;
    return this.probeBusy(projectDir, selfRunId, nowMs);
  }

  private failClosed(task: TaskEntry, reason: string): undefined {
    const completed = this.now().toISOString();
    this.registry.update(task.id, {
      status: 'stuck',
      completed_at: completed,
      notes: reason,
      not_before: undefined,
      defer_reason: undefined,
      defer_kind: undefined,
    });
    this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: reason });
    return undefined;
  }

  /**
   * Every quick launch must have a durable run identity before systemd can
   * start it. A readable existing run (approval resume/rerun) is already bound;
   * an uninitialized id is accepted only when its reservation marker validates.
   */
  private prepareRunBinding(task: TaskEntry): TaskEntry | undefined {
    if (task.kind === 'campaign') return task;
    try {
      assertTaskBriefAdmission(task);
    } catch (err) {
      return this.failClosed(task, err instanceof Error ? err.message : String(err));
    }
    if (task.run_id) {
      if (this.readBoundRun(task)) return task;
      if (readRunReservation(task.projectDir, task.run_id, this.now().getTime())) return task;
      return this.failClosed(task, `bound run ${task.run_id} is unreadable and has no valid reservation; refusing to replay brief`);
    }
    try {
      const reservation = this.allocateRun(task.projectDir, this.now());
      return this.registry.update(task.id, { run_id: reservation.runId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.failClosed(task, `could not reserve and bind run before launch: ${detail}`);
    }
  }

  private claimTaskLaunch(task: TaskEntry): boolean {
    if (task.kind === 'campaign') return true;
    if (!task.run_id) return false;
    try {
      return claimLaunchIntent(task.projectDir, task.run_id, this.now().getTime()).claimed;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.failClosed(task, `could not record launch intent before launch: ${detail}`);
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    // Catch-up sweep BEFORE arming the interval: a daemon restart otherwise
    // leaves every active task unvisited for a full interval, and any task
    // created-but-not-launched when the daemon died would wait forever.
    void this.tickOnce();
    this.timer = setInterval(() => void this.tickOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async register(input: TaskCreateInput): Promise<TaskEntry> {
    if ((input.kind ?? (input.config_path ? 'campaign' : 'quick')) !== 'campaign') {
      const brief = input.brief_text ?? (input.brief_path ? readFileSync(input.brief_path, 'utf-8') : input.name ?? '');
      const verification = verifyBriefAdmission(brief, input.brief_admission);
      if (verification.status !== 'valid') {
        throw new Error(admissionFailureMessage(verification.status, verification.report.digest));
      }
    }
    let task = this.registry.create(input);
    // Admission control (skip-on-overlap): single-in-flight per project used to
    // be enforced only INSIDE the launched run — the daemon spawned a second
    // unit anyway, the child killed itself on the conflict, systemd reported
    // the unit failed, and that counted as a crash worth retrying. A task could
    // burn its whole retry budget in seconds on a conflict it only had to wait
    // out (task #1817, live). Defer instead of launching into a busy project.
    invalidateRunLockCache();
    const busy = this.busyFor(task.projectDir, task.run_id);
    if (busy) return this.defer(task, `project busy (run ${busy})`, 'wait');
    const prepared = this.prepareRunBinding(task);
    if (!prepared) return this.registry.get(task.id) ?? task;
    task = prepared;
    if (!this.claimTaskLaunch(task)) {
      const blocker = this.busyFor(task.projectDir, task.run_id) ?? 'another launch';
      return this.defer(task, `project busy (run ${blocker})`, 'wait', task.run_id);
    }
    const command = this.prepareLaunchCommand(task);
    if (!command) return this.registry.get(task.id) ?? task;
    const now = this.now().toISOString();
    // Publish launch ownership before awaiting systemd-run. The exact brief and
    // admission were re-read and bound into `command` above, before this status
    // mutation, so a mismatch can never leave a task falsely marked running.
    const running = this.registry.update(task.id, { status: 'running', started_at: now });
    this.launchingTaskIds.add(task.id);
    try {
      await this.launch(running, running.systemd_unit, command);
      return this.registry.get(task.id) ?? running;
    } finally {
      this.launchingTaskIds.delete(task.id);
    }
  }

  /**
   * Park a task in the deferred queue with a backoff window. Deferring never
   * consumes the retry budget: waiting for a busy project is not a failure.
   */
  private defer(task: TaskEntry, reason: string, kind: 'wait' | 'retry', runId?: string): TaskEntry {
    const waitMs = Math.min(DEFER_BASE_MS * 2 ** Math.max(0, task.attempt - 1), DEFER_MAX_MS);
    const notBefore = new Date(this.now().getTime() + waitMs).toISOString();
    const updated = this.registry.update(task.id, {
      status: 'deferred', not_before: notBefore, defer_reason: reason, defer_kind: kind,
      ...(runId ? { run_id: runId } : {}),
    });
    this.registry.appendTick(task.id, { status: 'deferred', message: `${reason}; retry after ${notBefore}` });
    return updated;
  }

  async cancel(id: number): Promise<CancellationResult> {
    return this.cancellations.cancelTask(id);
  }

  async cancelRun(runId: string, unit?: string): Promise<CancellationResult> {
    return this.cancellations.cancelRun(runId, unit);
  }

  async retry(id: number): Promise<TaskEntry> {
    const task = this.mustGet(id);
    return this.relaunch(task, 'manual retry');
  }

  async tail(id: number, lines = 100, _follow = false): Promise<string> {
    const task = this.mustGet(id);
    return this.systemd.journalTail(task.systemd_unit, lines, false);
  }

  async tailSnapshot(id: number, lines = 100): Promise<SupervisorTailSnapshot> {
    const task = this.mustGet(id);
    if (this.systemd.tailSnapshot) {
      return this.systemd.tailSnapshot(task.systemd_unit, lines);
    }
    // Older/injected backends cannot bind output to a file cursor. Preserve the
    // source without inventing one so older daemon responses remain lossless:
    // the CLI will conservatively follow a cursorless file from byte zero.
    const output = await this.tail(id, lines, false);
    const source = this.systemd.logSource
      ? await this.systemd.logSource(task.systemd_unit)
      : { kind: 'journal' as const, unit: task.systemd_unit };
    return { output, source };
  }

  async tailSource(id: number): Promise<SupervisorLogSource> {
    const task = this.mustGet(id);
    if (this.systemd.logSource) return this.systemd.logSource(task.systemd_unit);
    return { kind: 'journal', unit: task.systemd_unit };
  }

  /** Minimal Phase 3 projection: durable supervisor outcome, without run.json merging. */
  async unitStatus(id: number): Promise<UnitStatus> {
    const task = this.mustGet(id);
    const backend = this.systemd;
    return backend.isActive(task.systemd_unit);
  }

  status(): { uptime: number; watched_tasks: number; registry_unreadable_records: number } {
    const snapshot = this.registry.snapshot();
    const watched = snapshot.tasks.filter((task) => isActiveTaskStatus(task.status)).length;
    return {
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      watched_tasks: watched,
      registry_unreadable_records: snapshot.unreadableRecords,
    };
  }

  async tickOnce(): Promise<void> {
    // Reentrancy guard: setInterval does not wait for the previous sweep. Once
    // per-task work (systemctl, git, project probes) pushes a sweep past the
    // interval, overlapping sweeps would relaunch the same task twice under the
    // same unit name — and the second systemd-run failure silently degrades to
    // a detached bash child, i.e. two live agent processes for one task.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const tasks = this.registry.list({ status: TASK_LIST_STATUS.ACTIVE });
      // Pass 1 (serial, cheap): drain the launch queue. Serial on purpose —
      // admission control must see each launch before deciding the next, or two
      // deferred tasks for the same project both pass the busy check.
      for (const task of tasks) {
        if (task.status === TASK_STATUS.DEFERRED || (task.status === TASK_STATUS.PENDING && !task.started_at)) {
          await this.tryLaunchQueued(task);
        }
      }
      // Pass 2 (concurrent): poll the already-running units. One hung
      // systemctl/git call must not wedge every other task's tick.
      const executing = this.registry.list({ status: TASK_LIST_STATUS.ACTIVE })
        .filter((task) => task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.CANCELLING);
      await Promise.allSettled(executing.map((task) => (
        task.status === TASK_STATUS.CANCELLING
          ? this.cancellations.cancelTask(task.id)
          : this.tickTask(task)
      )));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Launch a queued (deferred / never-launched) task when its backoff has
   * elapsed and its project is free; otherwise leave it queued.
   */
  private async tryLaunchQueued(task: TaskEntry): Promise<void> {
    // The sweep's task snapshot may predate a concurrent register() status
    // write. Re-read before doing any asynchronous admission work.
    const current = this.registry.get(task.id);
    if (!current || (current.status !== TASK_STATUS.DEFERRED && current.status !== TASK_STATUS.PENDING)) return;
    task = current;
    if (this.launchingTaskIds.has(task.id)) return;

    // A bound run owns this task's lifecycle. Terminal reconciliation is
    // intentionally checked even during a backoff window so an out-of-band
    // approval resume can settle promptly and can never fall through to launch.
    const bound = this.readBoundRun(task);
    if (bound && this.isSingleFlightCollision(bound)) {
      this.deferSingleFlightCollision(task, bound);
      return;
    }
    if (bound && isTerminalRunStatus(bound.status)) {
      await this.reconcileTerminalBoundRun(task, bound);
      return;
    }
    if (task.not_before && this.now().getTime() < Date.parse(task.not_before)) return;

    // Any readable, non-terminal bound run is still the original execution:
    // running means the approval CLI owns the resume; parked means it is
    // awaiting that resume; other lifecycle states are likewise not authority
    // to create a brand-new run from the brief.
    if (bound) {
      const reason = isPausedRunStatus(bound.status)
        ? `bound run ${bound.runId} is awaiting approval resume`
        : `bound run ${bound.runId} is ${bound.status}; waiting for existing run`;
      this.defer(task, reason, 'wait', task.run_id);
      return;
    }
    if (task.kind !== 'campaign' && task.run_id && !readRunReservation(task.projectDir, task.run_id, this.now().getTime())) {
      this.failClosed(task, `bound run ${task.run_id} is unreadable and has no valid reservation; refusing to replay brief`);
      return;
    }

    // Never relaunch a brief whose run is parked on an approval — the resume
    // path (`flowcrew inbox approve`) owns that run.
    if (this.parkTaskIfRunParked(task)) return;
    // Catch-up must gate on EVIDENCE, not on assumption: a task can be queued
    // with a unit that is already live (the daemon died between launch and the
    // status write). Launching again reuses the transient unit name, systemd
    // refuses it, and runUnit silently degrades to an untracked detached child
    // — two agent processes for one task. Adopt the live unit instead.
    const observedUnitState = await this.systemd.isActive(task.systemd_unit);
    // Cancellation can complete while the asynchronous unit probe is in
    // flight. Re-read before any adoption/claim/launch mutation so a stale
    // queued snapshot can never resurrect a cancelled task.
    const afterUnitProbe = this.registry.get(task.id);
    if (
      !afterUnitProbe
      || (afterUnitProbe.status !== TASK_STATUS.DEFERRED && afterUnitProbe.status !== TASK_STATUS.PENDING)
    ) return;
    task = afterUnitProbe;
    switch (observedUnitState.kind) {
      case 'active':
        this.registry.update(task.id, {
          status: 'running', started_at: task.started_at ?? this.now().toISOString(),
          not_before: undefined, defer_reason: undefined, defer_kind: undefined,
        });
        this.registry.appendTick(task.id, { status: 'running', message: `adopted live unit ${task.systemd_unit}` });
        return;
      case 'deactivating':
        this.registry.appendTick(task.id, {
          status: task.status,
          message: `unit ${task.systemd_unit} is still deactivating; launch remains deferred`,
        });
        return;
      case 'unobservable':
        this.registry.appendTick(task.id, {
          status: task.status,
          message: `unit ${task.systemd_unit} is unobservable (${observedUnitState.reason}); launch remains deferred`,
        });
        return;
      case 'terminal-unknown':
        await this.handleTerminalUnknown(task, observedUnitState.reason);
        return;
      case 'terminal':
      case 'absent':
        break;
      default: {
        const _exhaustive: never = observedUnitState;
        return _exhaustive;
      }
    }
    invalidateRunLockCache();
    const busy = this.busyFor(task.projectDir, task.run_id);
    if (busy) {
      this.defer(task, `project busy (run ${busy})`, task.defer_kind ?? 'wait');
      return;
    }
    const prepared = this.prepareRunBinding(task);
    if (!prepared) return;
    task = prepared;
    if (!this.claimTaskLaunch(task)) {
      const latest = this.registry.get(task.id);
      if (latest?.status === 'stuck') return;
      const blocker = this.busyFor(task.projectDir, task.run_id) ?? 'another launch';
      this.defer(task, `project busy (run ${blocker})`, task.defer_kind ?? 'wait', task.run_id);
      return;
    }
    const command = this.prepareLaunchCommand(task);
    if (!command) return;
    // A task that already had a unit needs a fresh unit name: systemd refuses to
    // reuse a transient unit name, and that refusal degrades to an untracked
    // detached child.
    const consumesAttempt = task.defer_kind === 'retry';
    const usedBefore = consumesAttempt || Boolean(task.started_at) || (task.launch_seq ?? 0) > 0;
    const attempt = consumesAttempt ? task.attempt + 1 : task.attempt;
    const launchSeq = usedBefore ? (task.launch_seq ?? 0) + 1 : (task.launch_seq ?? 0);
    const unit = !usedBefore
      ? task.systemd_unit
      : consumesAttempt
        ? `flowcrew-task-${task.id}-attempt-${attempt}.service`
        : `flowcrew-task-${task.id}-attempt-${attempt}-launch-${launchSeq}.service`;
    const updated = this.registry.update(task.id, {
      status: 'running', attempt, launch_seq: launchSeq, systemd_unit: unit,
      started_at: this.now().toISOString(), not_before: undefined, defer_reason: undefined, defer_kind: undefined,
    });
    this.launchingTaskIds.add(task.id);
    try {
      await this.launch(updated, unit, command);
    } finally {
      this.launchingTaskIds.delete(task.id);
    }
    // A concurrent cancellation waits for launchingTaskIds to clear and may
    // settle immediately after the finally block. Do not append a late
    // "running" tick after the registry already says cancelling/cancelled.
    if (this.registry.get(task.id)?.status === TASK_STATUS.RUNNING) {
      this.registry.appendTick(task.id, {
        status: 'running',
        message: `launched ${unit}${usedBefore ? ` (attempt ${attempt})` : ''}`,
      });
    }
  }

  private async tickTask(task: TaskEntry): Promise<void> {
    if (this.launchingTaskIds.has(task.id)) return;
    // A parked run EXITS its process on purpose (freeing the project and the
    // queue) while a human decides. To systemd that is indistinguishable from a
    // clean exit or a crash, so ask the run itself first — otherwise the
    // retry/stuck logic below would relaunch the brief and re-run the very
    // consequential action that is waiting for approval.
    if (this.parkTaskIfRunParked(task)) return;
    const state = await this.systemd.isActive(task.systemd_unit);
    const current = this.registry.get(task.id);
    if (!current) return;
    if (current.status === TASK_STATUS.CANCELLING) {
      await this.cancellations.cancelTask(task.id);
      return;
    }
    if (current.status !== TASK_STATUS.RUNNING) return;
    task = current;
    switch (state.kind) {
      case 'active': {
        const patch: Partial<TaskEntry> = { status: TASK_STATUS.RUNNING };
        if (!task.started_at) patch.started_at = this.now().toISOString();
        this.registry.update(task.id, patch);
        this.registry.appendTick(task.id, { status: 'active', stages: this.readStages(task) });
        return;
      }
      case 'deactivating':
        this.registry.appendTick(task.id, {
          status: 'deactivating',
          message: `supervisor reported ${task.systemd_unit} is deactivating`,
        });
        return;
      case 'unobservable':
        this.registry.appendTick(task.id, {
          status: 'unobservable',
          message: `supervisor could not observe ${task.systemd_unit}: ${state.reason}`,
        });
        return;
      case 'absent':
        await this.handleInactive(task);
        return;
      case 'terminal': {
        if (state.exitCode === 0) {
          await this.handleInactive(task);
          return;
        }
        const reason = state.signal
          ? `unit terminated by ${state.signal} (normalized exit ${state.exitCode})`
          : `unit exited with code ${state.exitCode}`;
        if (await this.reconcileBoundRunAfterExit(task, reason)) return;
        await this.retryOrStuck(task, reason);
        return;
      }
      case 'terminal-unknown':
        await this.handleTerminalUnknown(task, state.reason);
        return;
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  private async handleTerminalUnknown(task: TaskEntry, detail: string): Promise<void> {
    const bound = this.readBoundRun(task);
    if (bound && isTerminalRunStatus(bound.status)) {
      await this.reconcileTerminalBoundRun(task, bound);
      return;
    }
    const suffix = bound ? `; bound run ${bound.runId} remains ${bound.status}` : '';
    this.failClosed(task, `supervisor outcome unknown: ${detail}${suffix}; refusing to retry automatically`);
  }

  /**
   * If the task's project has a run parked on an approval, park the TASK too:
   * 'deferred' with a bounded not_before. Each elapsed window re-folds the
   * inbox, so abandoned or already-resolved parks cannot pin the queue forever.
   */
  private parkTaskIfRunParked(task: TaskEntry): boolean {
    const parked = findParkedRunForProject(task.projectDir, task.started_at ?? task.created_at);
    if (!parked) return false;
    const reason = `awaiting human approval (run ${parked.runId}, request ${parked.requestId}); resolve with: flowcrew inbox approve ${parked.requestId}`;
    this.defer(task, reason, 'wait', parked.runId);
    return true;
  }

  private boundRunPath(runIdOrPath: string): string {
    return isAbsolute(runIdOrPath) ? resolve(runIdOrPath) : join(runsRoot(), runIdOrPath);
  }

  private readBoundRun(task: TaskEntry): BoundRun | undefined {
    if (!task.run_id) return undefined;
    const path = this.boundRunPath(task.run_id);
    try {
      const parsed = JSON.parse(readFileSync(join(path, 'run.json'), 'utf-8')) as {
        runId?: unknown;
        status?: unknown;
        failureReason?: unknown;
      };
      if (typeof parsed.status !== 'string') return undefined;
      return {
        runId: typeof parsed.runId === 'string' && parsed.runId ? parsed.runId : basename(path),
        path,
        status: parsed.status,
        ...(typeof parsed.failureReason === 'string' ? { failureReason: parsed.failureReason } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private isSingleFlightCollision(bound: BoundRun): boolean {
    return bound.status === RUN_STATUS.FAILED && bound.failureReason?.startsWith('Single-in-flight') === true;
  }

  private deferSingleFlightCollision(task: TaskEntry, bound: BoundRun): void {
    if (task.run_id) releaseLaunchIntent(task.projectDir, task.run_id);
    const unbound = this.registry.update(task.id, {
      run_id: undefined,
      notes: `bound run ${bound.runId} hit project single-in-flight guard; waiting without consuming retry budget`,
    });
    this.defer(
      unbound,
      `project busy after single-in-flight guard (${bound.failureReason ?? bound.runId})`,
      'wait',
    );
  }

  /**
   * A stopped unit is transport evidence only. Reconcile the bound run first:
   * terminal verdicts settle, active/parked runs wait, guard collisions defer,
   * and an unreadable known binding fails closed. Only a valid reservation or
   * a legacy unbound task may fall through to crash retry.
   */
  private async reconcileBoundRunAfterExit(task: TaskEntry, reason: string): Promise<boolean> {
    const bound = this.readBoundRun(task);
    if (bound) {
      if (this.isSingleFlightCollision(bound)) {
        this.deferSingleFlightCollision(task, bound);
        return true;
      }
      if (isTerminalRunStatus(bound.status)) {
        await this.reconcileTerminalBoundRun(task, bound);
        return true;
      }
      const detail = isPausedRunStatus(bound.status)
        ? `bound run ${bound.runId} is awaiting approval resume`
        : `bound run ${bound.runId} is ${bound.status}; waiting for existing run`;
      this.defer(task, `${reason}; ${detail}`, 'wait', task.run_id);
      return true;
    }
    if (!task.run_id) return false; // legacy early crash
    if (readRunReservation(task.projectDir, task.run_id, this.now().getTime())) return false;
    this.failClosed(task, `${reason}; bound run ${task.run_id} is unreadable and has no valid reservation; refusing to replay brief`);
    return true;
  }

  private async reconcileTerminalBoundRun(task: TaskEntry, bound: BoundRun): Promise<void> {
    releaseLaunchIntent(task.projectDir, bound.runId);
    if (isSuccessfulRunStatus(bound.status)) {
      await this.handleInactive(task, `bound run ${bound.runId} ended ${bound.status}`);
      return;
    }
    const completed = this.now().toISOString();
    const status = bound.status === RUN_STATUS.REALITY_GATE_FAILED
      ? TASK_STATUS.REALITY_GATE_FAILED
      : TASK_STATUS.FAILED;
    const message = `bound run ${bound.runId} ended ${bound.status}`;
    this.registry.update(task.id, {
      status,
      completed_at: completed,
      notes: message,
      not_before: undefined,
      defer_reason: undefined,
      defer_kind: undefined,
    });
    this.registry.appendTick(task.id, { ts: completed, status, message });
  }

  /**
   * Reconcile an inactive unit. completionOnlyReason is set for a terminal
   * bound run: all verification still runs, but a missing commit can only
   * settle to operator-visible stuck state, never back into a launch queue.
   */
  private async handleInactive(task: TaskEntry, completionOnlyReason?: string): Promise<void> {
    if (!completionOnlyReason && await this.reconcileBoundRunAfterExit(task, 'unit inactive')) return;
    const completed = this.now().toISOString();
    if (task.commit_prefix) {
      const commit = await this.git.findCommitByPrefix(task.projectDir, task.commit_prefix);
      if (commit) {
        const missing = (task.expected_artifacts ?? []).filter((p) => !existsSync(resolve(task.projectDir, p)));
        if (missing.length === 0) {
          const summary = this.readCompletionSummary(task, completed, commit);
          if (!summary) return;
          this.registry.update(task.id, {
            status: 'done',
            completed_at: completed,
            completing_commit: commit,
            summary_verdict: summary.parsed.verdict,
            summary_one_liner: summary.parsed.oneLiner,
            summary_full: summary.parsed.full,
            summary_source: summary.path,
            summary_parsed_at: completed,
            not_before: undefined,
            defer_reason: undefined,
            defer_kind: undefined,
          });
          this.registry.appendTick(task.id, { ts: completed, status: 'done', message: `commit ${commit}; summary ${summary.path}` });
        } else {
          this.registry.update(task.id, {
            status: 'stuck', completed_at: completed, completing_commit: commit,
            notes: `missing artifacts: ${missing.join(', ')}`,
            not_before: undefined, defer_reason: undefined, defer_kind: undefined,
          });
          this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: `missing artifacts: ${missing.join(', ')}` });
        }
        return;
      }
    }

    // No commit_prefix match (or no commit_prefix declared). Before declaring
    // the worktree "stuck on uncommitted changes", check whether the unit
    // produced ANY commit during its lifetime — planner-style workflows
    // commit their output (e.g. backlog edits) but routinely leave behind
    // worktree noise (logs, sqlite-wal, codex .tmp). A successful commit +
    // leftover WIP should be `done`, not `stuck`.
    if (task.started_at) {
      const recent = await this.git.findCommitSince(task.projectDir, task.started_at);
      if (recent) {
        this.registry.update(task.id, {
          status: 'done',
          completed_at: completed,
          completing_commit: recent.sha,
          notes: `unit committed during lifetime (${recent.subject}); leftover worktree WIP ignored`,
          not_before: undefined,
          defer_reason: undefined,
          defer_kind: undefined,
        });
        this.registry.appendTick(task.id, {
          ts: completed,
          status: 'done',
          message: `commit ${recent.sha} (no prefix match; WIP ignored)`,
        });
        return;
      }
    }

    if (await this.git.hasUncommittedChanges(task.projectDir)) {
      this.registry.update(task.id, {
        status: 'stuck', completed_at: completed,
        notes: 'unit exited cleanly with uncommitted changes; operator review needed',
        not_before: undefined, defer_reason: undefined, defer_kind: undefined,
      });
      this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: 'uncommitted changes need operator review' });
      return;
    }

    if (completionOnlyReason) {
      const message = `${completionOnlyReason}; no completing commit or worktree changes found`;
      this.registry.update(task.id, {
        status: 'stuck', completed_at: completed, notes: message,
        not_before: undefined, defer_reason: undefined, defer_kind: undefined,
      });
      this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message });
      return;
    }
    await this.retryOrStuck(task, 'unit exited without commit or changes');
  }

  private readCompletionSummary(task: TaskEntry, completed: string, commit: string): { path: string; parsed: ReturnType<typeof parseTaskSummary> } | undefined {
    const summaryPaths = this.summaryPaths(task);
    const summaryPath = summaryPaths.find((p) => existsSync(p) && statSync(p).isFile());
    if (!summaryPath) {
      const message = `task_summary.md not found in expected locations: ${summaryPaths.join(', ')}`;
      this.registry.update(task.id, {
        status: 'needs_summary', completed_at: completed, completing_commit: commit, notes: message,
        not_before: undefined, defer_reason: undefined, defer_kind: undefined,
      });
      this.registry.appendTick(task.id, { ts: completed, status: 'needs_summary', message });
      return undefined;
    }

    const parsed = parseTaskSummary(readFileSync(summaryPath, 'utf-8'));
    if (!parsed.valid) {
      const message = `task_summary.md malformed: ${parsed.errors.join('; ')}`;
      this.registry.update(task.id, {
        status: 'needs_summary', completed_at: completed, completing_commit: commit, notes: message,
        not_before: undefined, defer_reason: undefined, defer_kind: undefined,
      });
      this.registry.appendTick(task.id, { ts: completed, status: 'needs_summary', message });
      return undefined;
    }

    return { path: summaryPath, parsed };
  }

  private summaryPaths(task: TaskEntry): string[] {
    const paths: string[] = [];
    if (task.run_id) paths.push(join(this.boundRunPath(task.run_id), 'task_summary.md'));
    if (task.expected_summary_path) {
      const expectedPath = resolve(task.projectDir, task.expected_summary_path);
      paths.push(expectedPath);
      if (!expectedPath.endsWith('task_summary.md')) paths.push(join(expectedPath, 'task_summary.md'));
    }
    paths.push(join(task.projectDir, 'docs', 'task_summary.md'));
    return Array.from(new Set(paths));
  }

  private async retryOrStuck(task: TaskEntry, reason: string): Promise<void> {
    // A unit that died because the project was already busy is NOT a crash —
    // retrying it immediately just loses the same race again. Wait it out
    // without consuming the retry budget.
    invalidateRunLockCache();
    const busy = this.busyFor(task.projectDir, task.run_id);
    if (busy) {
      this.defer(task, `${reason}; project busy (run ${busy})`, 'wait', task.run_id);
      return;
    }
    if (task.attempt < task.max_retries) {
      await this.relaunch(task, reason);
      return;
    }
    const completed = this.now().toISOString();
    this.registry.update(task.id, { status: 'stuck', completed_at: completed, notes: reason });
    this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: reason });
  }

  /**
   * Queue a retry with backoff rather than relaunching inline. Relaunching from
   * inside the sweep meant a crash-looping task re-spawned every 30s with no
   * spacing; the queue drain in tickOnce() owns the actual launch.
   */
  private async relaunch(task: TaskEntry, reason: string): Promise<TaskEntry> {
    return this.defer(task, `retry: ${reason}`, 'retry');
  }

  private prepareLaunchCommand(task: TaskEntry): string | undefined {
    try {
      return buildCommand(task, this.cliPath);
    } catch (error) {
      if (task.run_id) releaseLaunchIntent(task.projectDir, task.run_id);
      const detail = error instanceof Error ? error.message : String(error);
      return this.failClosed(task, detail);
    }
  }

  private async launch(task: TaskEntry, unit: string, command: string): Promise<void> {
    await this.systemd.runUnit({
      unit,
      workingDirectory: task.projectDir,
      command,
    });
  }

  private readStages(task: TaskEntry): unknown {
    if (!task.run_id) return undefined;
    try {
      const runPath = this.boundRunPath(task.run_id);
      const parsed = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as { stages?: unknown };
      return parsed.stages;
    } catch {
      return undefined;
    }
  }

  private mustGet(id: number): TaskEntry {
    const task = this.registry.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}

export class NodeGit implements GitAdapter {
  async findCommitByPrefix(projectDir: string, prefix: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['log', '--format=%H %s', '-n', '50', '--grep', prefix], { cwd: projectDir });
      return stdout.trim().split(/\r?\n/).find(Boolean)?.split(/\s+/)[0];
    } catch {
      return undefined;
    }
  }

  async hasUncommittedChanges(projectDir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async findCommitSince(projectDir: string, isoSince: string): Promise<{ sha: string; subject: string } | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', `--since=${isoSince}`, '--format=%H%x09%s', '-n', '1'],
        { cwd: projectDir }
      );
      const line = stdout.trim().split(/\r?\n/).find(Boolean);
      if (!line) return undefined;
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    } catch {
      return undefined;
    }
  }
}

interface FallbackUnitRecord {
  pid?: number;
  state?: string;
  command?: string;
  /** Kept for disk compatibility; contains the ProcessStartToken value. */
  startTimeTicks?: string;
  startTokenKind?: ProcessStartToken['kind'];
  unverifiedPid?: number;
  reason?: string;
  completedAt?: string;
}

const FALLBACK_TERMINAL_STATE = {
  INACTIVE: 'inactive',
  FAILED: 'failed',
} as const;

export interface NodeSystemdOptions {
  /** Test seam and explicit override for minimal POSIX images. */
  shellPath?: string;
  /** Explicit shim entrypoint seam; normal resolution probes .js then .ts. */
  shimPath?: string;
  /** Test seam; production always uses the daemon's absolute interpreter. */
  nodePath?: string;
  startupGraceMs?: number;
  shutdownGraceMs?: number;
  retentionMs?: number;
  now?: () => Date;
}

export class NodeSystemd implements SupervisorBackend {
  private readonly baseDir: string;
  private readonly fallbackDir: string;
  private readonly configuredShellPath?: string;
  private readonly configuredShimPath?: string;
  private readonly nodePath: string;
  private readonly startupGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;

  constructor(baseDir: string, options: NodeSystemdOptions = {}) {
    this.baseDir = baseDir;
    this.fallbackDir = join(baseDir, 'systemd-fallback');
    this.configuredShellPath = options.shellPath;
    this.configuredShimPath = options.shimPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.startupGraceMs = Math.max(0, options.startupGraceMs ?? 5_000);
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 1_500);
    this.retentionMs = Math.max(0, options.retentionMs ?? 30 * 24 * 60 * 60_000);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.fallbackDir, { recursive: true });
    mkdirSync(supervisionPaths(this.baseDir, '_').root, { recursive: true });
    gcSupervisionDirectories(this.baseDir, {
      nowMs: this.now().getTime(),
      retentionMs: this.retentionMs,
    });
  }

  async isActive(unit: string): Promise<UnitStatus> {
    const portable = this.portableState(unit);
    // An atomically-written exit status is the only backend-independent result
    // and therefore outranks even a systemd unit that has not been reaped yet.
    if (portable.kind === 'terminal') return portable;
    try {
      const { stdout } = await execFileAsync(
        'systemctl',
        ['--user', 'is-active', unit],
        { encoding: 'utf-8', timeout: 1_000 },
      );
      return mergeSupervisorStatuses(portable, normalizeSystemdStatus(stdout));
    } catch (err) {
      const stdout = (err as { stdout?: string | Buffer }).stdout;
      if (stdout !== undefined && String(stdout).trim()) {
        return mergeSupervisorStatuses(portable, normalizeSystemdStatus(String(stdout)));
      }
      const failure = err as { killed?: boolean; signal?: string; code?: string | number };
      if (failure.killed || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT') {
        return { kind: 'unobservable', reason: 'systemctl probe timed out' };
      }
      if (failure.code === 'ENOENT') return this.fallbackState(unit);
      // A bound live shim is conservative positive evidence. Terminal-unknown
      // and absent cannot prove that a real unit stopped while systemctl itself
      // is unobservable, so those cases preserve the Phase 1 fail-closed rule.
      if (portable.kind === 'active' || portable.kind === 'deactivating') return portable;
      const legacy = this.legacyFallbackState(unit);
      if (legacy.kind === 'active' || legacy.kind === 'deactivating') return legacy;
      return { kind: 'unobservable', reason: 'systemctl probe failed' };
    }
  }

  async runUnit(opts: { unit: string; workingDirectory: string; command: string }): Promise<void> {
    gcSupervisionDirectories(this.baseDir, {
      nowMs: this.now().getTime(),
      retentionMs: this.retentionMs,
    });
    const paths = supervisionPaths(this.baseDir, opts.unit);
    if (hasSupervisionEvidence(this.baseDir, opts.unit)) {
      throw new Error(`supervision evidence already exists for ${opts.unit}; refusing to overwrite it`);
    }
    mkdirSync(paths.unitDir, { recursive: true });
    const shellPath = this.fallbackShellPath();
    const launch: SupervisionLaunchRecord = {
      version: SUPERVISION_PROTOCOL_VERSION,
      unit: opts.unit,
      workingDirectory: opts.workingDirectory,
      command: opts.command,
      nodePath: this.nodePath,
      shellPath,
      createdAt: this.now().toISOString(),
      shutdownGraceMs: this.shutdownGraceMs,
      legacyRecordPath: this.fallbackPath(opts.unit),
    };
    atomicWriteJson(paths.launch, launch);
    const shimArgs = this.shimArguments(paths.unitDir);
    try {
      await execFileAsync('systemd-run', [
        '--user',
        `--unit=${opts.unit}`,
        '--property=KillMode=mixed',
        `--working-directory=${opts.workingDirectory}`,
        this.nodePath,
        ...shimArgs,
      ], { timeout: 5_000 });
    } catch {
      try {
        const child = spawn(this.nodePath, shimArgs, {
          cwd: opts.workingDirectory,
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', (error) => {
          this.recordShimLaunchFailure(opts.unit, opts.command, error);
        });
        // Once spawn succeeds, the shim's exit alone cannot prove that no agent
        // was launched: it may have detached the agent and then died before it
        // could publish running.json. Keep launch.json as the durable evidence;
        // after the startup window readers conservatively report outcome unknown.
        // Only spawn's error event is authoritative proof that the shim never ran.
        child.unref();
      } catch (error) {
        this.recordShimLaunchFailure(opts.unit, opts.command, error);
      }
    }
  }

  async stopUnit(unit: string): Promise<void> {
    let systemctlError: unknown;
    try {
      await execFileAsync('systemctl', ['--user', 'stop', unit], { encoding: 'utf-8', timeout: 1_000 });
    } catch (error) {
      systemctlError = error;
    }
    if (hasSupervisionEvidence(this.baseDir, unit)) {
      const paths = supervisionPaths(this.baseDir, unit);
      const observation = observePortableUnit(this.baseDir, unit, {
        nowMs: this.now().getTime(),
        startupGraceMs: this.startupGraceMs,
      });
      if (observation.status.kind === 'terminal') return;
      const running = readSupervisionRunning(paths.running);
      if (!running || !await this.waitForPortableBinding(running)) return;

      // The legacy mirror remains only for upgrade compatibility and Phase 1
      // safety evidence. If somebody altered its command, fail closed instead
      // of letting that weaker record silently disagree with the durable one.
      try {
        const mirror = JSON.parse(readFileSync(this.fallbackPath(unit), 'utf-8')) as FallbackUnitRecord;
        if (typeof mirror.command === 'string' && mirror.command !== running.command) {
          if (systemctlError) throw systemctlError;
          return;
        }
      } catch (error) {
        if (error === systemctlError) throw error;
      }

      // The shim is deliberately outside the agent's process group. Signal the
      // strictly-bound shim as a bare PID; it owns TERM -> bounded KILL of the
      // agent group and writes exit.json only after reaping the agent.
      try {
        process.kill(running.shimPid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await this.waitForPortableExit(unit, running.shimPid);
      return;
    }
    await this.stopLegacyUnit(unit, systemctlError);
  }

  private async stopLegacyUnit(unit: string, systemctlError: unknown): Promise<void> {
    const path = this.fallbackPath(unit);
    if (!existsSync(path)) {
      if (systemctlError) throw systemctlError;
      return;
    }
    let fallbackPid: number | undefined;
    let record: FallbackUnitRecord = {};
    try {
      record = JSON.parse(readFileSync(path, 'utf-8')) as FallbackUnitRecord;
      if (Number.isInteger(record.pid) && (record.pid ?? 0) > 0) fallbackPid = record.pid;
    } catch { /* malformed fallback record */ }
    const recordedTicks = typeof record.startTimeTicks === 'string' && record.startTimeTicks
      ? record.startTimeTicks
      : undefined;
    const recordedKind = record.startTokenKind === 'posix-lstart' || record.startTokenKind === 'linux'
      ? record.startTokenKind
      : 'linux';
    const recordedToken: ProcessStartToken | undefined = recordedTicks
      ? { kind: recordedKind, value: recordedTicks }
      : undefined;
    const fallbackAlive = fallbackPid !== undefined && processIsAlive(fallbackPid);
    // A pid on its own is not evidence: the kernel reuses pids, so the number recorded when
    // this unit started may now belong to anything. BSD's second-resolution token is
    // additionally bound to the recorded command. A token that cannot be interpreted
    // removes signal authority, but is never treated as evidence that a live pid died.
    const identityBinds = fallbackPid !== undefined
      && fallbackAlive
      && processStartTokensMatch(recordedToken, processStartToken(fallbackPid))
      && typeof record.command === 'string'
      && processCommandMatches(fallbackPid, record.command);
    if (fallbackPid !== undefined && !identityBinds) {
      const reason = recordedTicks === undefined
        ? 'fallback record predates start-time binding; refusing to signal an unverifiable pid'
        : !fallbackAlive
          ? 'recorded start time no longer matches this pid; refusing to signal a recycled pid'
          : typeof record.command !== 'string' || !processCommandMatches(fallbackPid, record.command)
            ? 'recorded command no longer matches this pid; refusing to signal an unbound process'
            : 'recorded start time no longer matches this pid; refusing to signal a recycled pid';
      this.writeFallbackRecord(unit, {
        ...record,
        state: fallbackAlive ? 'active' : 'inactive',
        unverifiedPid: fallbackPid,
        reason,
        ...(!fallbackAlive ? { completedAt: record.completedAt ?? new Date().toISOString() } : {}),
      });
      if (systemctlError) throw systemctlError;
      return;
    }
    if (fallbackPid !== undefined) {
      const signalTarget = process.platform !== 'win32' ? -fallbackPid : fallbackPid;
      try { process.kill(signalTarget, 'SIGTERM'); } catch { /* confirmation below remains authoritative */ }
      if (processIsAlive(fallbackPid)) {
        const startToken = recordedToken;
        this.writeFallbackRecord(unit, {
          ...record,
          pid: fallbackPid,
          state: 'deactivating',
          ...(startToken ? {
            startTimeTicks: startToken.value,
            startTokenKind: startToken.kind,
          } : {}),
        });
        return;
      }
    }
    this.writeFallbackRecord(unit, {
      ...record,
      state: 'inactive',
      completedAt: record.completedAt ?? new Date().toISOString(),
    });
  }

  async journalTail(unit: string, lines: number, _follow = false): Promise<string> {
    const portableLogPath = supervisionPaths(this.baseDir, unit).log;
    const logPath = existsSync(portableLogPath) ? portableLogPath : this.fallbackLogPath(unit);
    // A systemd-less Linux host can still have a journalctl executable. The
    // fallback record/log, when present, is therefore stronger routing evidence
    // than command availability and must be read before consulting the journal.
    if (existsSync(logPath)) {
      return this.readFileLogSnapshot(logPath, lines).output;
    }
    try {
      const { stdout } = await execFileAsync('journalctl', ['--user', '-u', unit, '-n', String(lines), '--no-pager']);
      return stdout;
    } catch {
      return this.readFileLogSnapshot(logPath, lines).output;
    }
  }

  async tailSnapshot(unit: string, lines: number): Promise<SupervisorTailSnapshot> {
    const source = await this.logSource(unit);
    switch (source.kind) {
      case 'file': {
        // Derive both values from this one Buffer. A later stat would reopen the
        // blind interval between the daemon's output snapshot and the follower.
        const snapshot = this.readFileLogSnapshot(source.path, lines);
        return {
          output: snapshot.output,
          source: { ...source, offset: snapshot.offset },
        };
      }
      case 'journal':
        return { output: await this.journalTail(unit, lines, false), source };
      case 'unavailable':
        return { output: '', source };
      default: {
        const _exhaustive: never = source;
        return _exhaustive;
      }
    }
  }

  async logSource(unit: string): Promise<SupervisorLogSource> {
    const portableLogPath = supervisionPaths(this.baseDir, unit).log;
    if (hasSupervisionEvidence(this.baseDir, unit) || existsSync(portableLogPath)) {
      return { kind: 'file', path: portableLogPath };
    }
    const fallbackLogPath = this.fallbackLogPath(unit);
    if (existsSync(this.fallbackPath(unit)) || existsSync(fallbackLogPath)) {
      return { kind: 'file', path: fallbackLogPath };
    }
    return { kind: 'journal', unit };
  }

  private fallbackState(unit: string): UnitStatus {
    if (hasSupervisionEvidence(this.baseDir, unit)) return this.portableState(unit);
    return this.legacyFallbackState(unit);
  }

  private portableState(unit: string): UnitStatus {
    return observePortableUnit(this.baseDir, unit, {
      nowMs: this.now().getTime(),
      startupGraceMs: this.startupGraceMs,
    }).status;
  }

  private legacyFallbackState(unit: string): UnitStatus {
    const path = this.fallbackPath(unit);
    if (!existsSync(path)) return { kind: 'absent' };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as FallbackUnitRecord;
      if (parsed.state === FALLBACK_TERMINAL_STATE.INACTIVE
        || parsed.state === FALLBACK_TERMINAL_STATE.FAILED) {
        return {
          kind: 'terminal-unknown',
          reason: parsed.reason ?? `fallback process ended without an exit status (${parsed.state})`,
        };
      }
      if (parsed.pid && processIsAlive(parsed.pid)) {
        return parsed.state === 'deactivating' ? { kind: 'deactivating' } : { kind: 'active' };
      }
      this.writeFallbackRecord(unit, {
        ...parsed,
        state: 'inactive',
        completedAt: parsed.completedAt ?? new Date().toISOString(),
      });
      return { kind: 'terminal-unknown', reason: 'fallback process ended without an exit status' };
    } catch {
      this.writeFallbackRecord(unit, {
        state: 'failed',
        reason: 'fallback state record is malformed',
        completedAt: new Date().toISOString(),
      });
      return { kind: 'terminal-unknown', reason: 'fallback state record is malformed' };
    }
  }

  private fallbackShellPath(): string {
    if (this.configuredShellPath) return this.configuredShellPath;
    if (existsSync('/bin/bash')) return '/bin/bash';
    if (existsSync('/bin/sh')) return '/bin/sh';
    return 'sh';
  }

  private shimArguments(controlDir: string): string[] {
    const moduleDir = import.meta.dirname ?? '.';
    const jsPath = resolve(moduleDir, 'supervise-shim.js');
    const tsPath = resolve(moduleDir, 'supervise-shim.ts');
    const shimPath = this.configuredShimPath
      ?? (existsSync(jsPath) ? jsPath : tsPath);
    if (!shimPath.endsWith('.ts')) return [shimPath, controlDir];
    let tsxLoader: string;
    try {
      tsxLoader = import.meta.resolve('tsx');
    } catch {
      return [shimPath, controlDir];
    }
    return ['--import', tsxLoader, shimPath, controlDir];
  }

  private recordShimLaunchFailure(unit: string, command: string, error: unknown): void {
    const reason = `shim launcher spawn failed: ${error instanceof Error ? error.message : String(error)}`;
    const endedAt = this.now().toISOString();
    const exit: SupervisionExitRecord = {
      version: SUPERVISION_PROTOCOL_VERSION,
      exitCode: null,
      normalized: 127,
      endedAt,
      reason,
    };
    atomicWriteJson(supervisionPaths(this.baseDir, unit).exit, exit);
    this.writeFallbackRecord(unit, {
      state: 'failed',
      command,
      reason,
      completedAt: endedAt,
    });
  }

  private async waitForPortableExit(unit: string, shimPid: number): Promise<void> {
    const deadline = Date.now() + this.shutdownGraceMs + 2_500;
    const exitPath = supervisionPaths(this.baseDir, unit).exit;
    while (Date.now() < deadline) {
      if (existsSync(exitPath) || !processIsAlive(shimPid)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  private async waitForPortableBinding(running: SupervisionRunningRecord): Promise<boolean> {
    for (let attempt = 0; attempt < PORTABLE_BIND_ATTEMPTS; attempt += 1) {
      const binding = runningRecordBindingStatus(running);
      if (binding === 'bound') return true;
      // A recorded token or command mismatch is definitive and keeps its veto.
      // Only an unreadable process-table sample may be retried; it never grants
      // signal authority and is never treated as evidence that the shim died.
      if (binding === 'unbound') return false;
      if (attempt + 1 < PORTABLE_BIND_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, PORTABLE_BIND_INTERVAL_MS));
      }
    }
    return false;
  }

  private writeFallbackRecord(unit: string, record: FallbackUnitRecord): void {
    writeFileSync(this.fallbackPath(unit), JSON.stringify(record), 'utf-8');
  }

  private fallbackPath(unit: string): string {
    return join(this.fallbackDir, `${unit.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }

  private fallbackLogPath(unit: string): string {
    return join(this.fallbackDir, `${unit.replace(/[^a-zA-Z0-9_.-]/g, '_')}.log`);
  }

  private readFileLogSnapshot(path: string, lines: number): { output: string; offset: number } {
    try {
      const buffer = readFileSync(path);
      const log = buffer.toString('utf-8');
      const rows = log.split(/\r?\n/);
      if (rows.at(-1) === '') rows.pop();
      return {
        output: rows.slice(-Math.max(0, lines)).join('\n') + (rows.length > 0 ? '\n' : ''),
        offset: buffer.length,
      };
    } catch {
      return { output: '', offset: 0 };
    }
  }
}

function mergeSupervisorStatuses(portable: UnitStatus, systemd: UnitStatus): UnitStatus {
  if (portable.kind === 'terminal') return portable;
  switch (systemd.kind) {
    case 'active':
      // Without an exit sentinel, a live unit vetoes stale/missing portable
      // metadata. Misclassifying it as terminal lets catch-up launch a second
      // agent under a transient unit name that systemd will reject.
      return { kind: 'active' };
    case 'deactivating':
      return { kind: 'deactivating' };
    case 'unobservable':
      return portable.kind === 'active' || portable.kind === 'deactivating'
        ? portable
        : systemd;
    case 'terminal':
    case 'terminal-unknown':
    case 'absent':
      return portable.kind === 'absent' ? systemd : portable;
    default: {
      const _exhaustive: never = systemd;
      return _exhaustive;
    }
  }
}

function normalizeSystemdStatus(output: string): UnitStatus {
  const state = output.trim();
  switch (state) {
    case 'active':
    case 'activating':
    case 'reloading':
      return { kind: 'active' };
    case 'deactivating':
      return { kind: 'deactivating' };
    case FALLBACK_TERMINAL_STATE.INACTIVE:
    case FALLBACK_TERMINAL_STATE.FAILED:
      return { kind: 'terminal-unknown', reason: `systemd reported ${state} without an exit status` };
    case '':
    case 'unknown':
    case 'not-found':
      return { kind: 'absent' };
    default:
      return { kind: 'unobservable', reason: `systemd reported unsupported state ${state}` };
  }
}

function readBrief(task: TaskEntry): string {
  if (task.brief_text) return task.brief_text;
  if (task.brief_path) return readFileSync(task.brief_path, 'utf-8');
  return task.name;
}

function admissionFailureMessage(status: ReturnType<typeof verifyBriefAdmission>['status'], digest: string): string {
  return `Brief admission ${status}; refusing to launch before a fresh visible preflight decision (current digest ${digest.slice(0, 12)}).`;
}

function readRunAdmission(task: TaskEntry): BriefAdmissionRecord | undefined {
  if (!task.run_id) return undefined;
  try {
    const runPath = isAbsolute(task.run_id) ? resolve(task.run_id) : join(runsRoot(), task.run_id);
    const parsed = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as {
      briefAdmission?: BriefAdmissionRecord;
    };
    return parsed.briefAdmission;
  } catch {
    return undefined;
  }
}

function readBoundRunBrief(task: TaskEntry): string | undefined {
  if (!task.run_id) return undefined;
  try {
    const runPath = isAbsolute(task.run_id) ? resolve(task.run_id) : join(runsRoot(), task.run_id);
    const sidecar = join(runPath, 'task_brief.md');
    if (existsSync(sidecar)) return readFileSync(sidecar, 'utf-8');
    const parsed = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as { taskDescription?: unknown };
    return typeof parsed.taskDescription === 'string' ? parsed.taskDescription : undefined;
  } catch {
    return undefined;
  }
}

function assertTaskBriefAdmission(task: TaskEntry): { brief: string; admission: BriefAdmissionRecord } {
  const brief = readBrief(task);
  const taskVerification = verifyBriefAdmission(brief, task.brief_admission);
  if (taskVerification.status !== 'valid' || !task.brief_admission) {
    throw new Error(admissionFailureMessage(taskVerification.status, taskVerification.report.digest));
  }
  const boundPath = task.run_id
    ? (isAbsolute(task.run_id) ? resolve(task.run_id) : join(runsRoot(), task.run_id))
    : undefined;
  if (boundPath && existsSync(join(boundPath, 'run.json'))) {
    const runAdmission = readRunAdmission(task);
    const runBrief = readBoundRunBrief(task) ?? '';
    const runVerification = verifyBriefAdmission(runBrief, runAdmission);
    if (runVerification.status !== 'valid' || !runAdmission) {
      throw new Error(`Bound run ${task.run_id}: ${admissionFailureMessage(runVerification.status, runVerification.report.digest)}`);
    }
    if (runAdmission.digest !== task.brief_admission.digest || runBrief !== brief) {
      throw new Error(`Bound run ${task.run_id}: task and run admission digests differ; refusing to launch.`);
    }
  }
  return { brief, admission: task.brief_admission };
}

export function buildCommand(task: TaskEntry, cliPath: string): string {
  const userArgs: string[] = [];
  for (let i = 0; i < (task.launch_args ?? []).length; i++) {
    const arg = task.launch_args![i];
    if (arg === '--existing-run-id'
      || arg === '--task'
      || arg === '--brief-input-base64'
      || arg === '--project'
      || arg === '--brief-admission-record') {
      i += 1; // daemon-owned exact-input fields cannot be overridden by caller args
      continue;
    }
    if (arg === '--acknowledge-brief-warnings'
      || arg.startsWith('--acknowledge-brief-warnings=')
      || arg === '--background'
      || arg === '-') {
      continue;
    }
    userArgs.push(arg);
  }
  const admitted = task.kind === 'campaign' ? undefined : assertTaskBriefAdmission(task);
  const args = task.kind === 'campaign'
    ? ['campaign', 'run', task.config_path ?? '', ...userArgs]
    : ['quick',
       // The brief must survive shellJoin AND systemd's own ExecStart unescaping.
       // Passing it raw corrupted any brief containing a single quote, so the
       // relaunch recomputed a different digest than the one the operator
       // admitted and the launch was rejected before run creation. base64url is
       // the same byte-safe transport --brief-admission-record already uses.
       '--brief-input-base64', Buffer.from(admitted!.brief, 'utf8').toString('base64url'),
       '--project', task.projectDir,
       '--supervise', ...userArgs,
       '--brief-admission-record', Buffer.from(JSON.stringify(admitted!.admission), 'utf8').toString('base64url'),
       ...(task.run_id ? ['--existing-run-id', task.run_id] : [])];
  return shellJoin([process.execPath, cliPath, ...args.filter(Boolean)]);
}

function shellJoin(parts: string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
}
