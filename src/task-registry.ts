import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite, appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from './engine-fs.js';
import { constants, existsSync, fstatSync, fsyncSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fcGlobalDir } from './store.js';
import { TASK_STATUS, isActiveTaskStatus, isKnownTaskStatus, type TaskStatus } from './lifecycle-status.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';
import type { LaunchTarget } from './session-push.js';
import { processLiveness, type ProcessStartToken } from './process-liveness.js';
import { lockOwnerIdentity, parseLockOwner, publishLockOwner, recoverStaleLock, type LockObservation } from './lock-publication.js';
export { TASK_STATUS, isActiveTaskStatus } from './lifecycle-status.js';
export type { TaskStatus } from './lifecycle-status.js';

// 'deferred' — admitted but intentionally NOT launched yet (the project has a
// live run, or a backoff window is open). It is an ACTIVE state: the tick sweep
// must keep visiting it or the task silently never launches. Distinct from
// 'pending' (created, launch imminent) and from 'stuck' (needs a human).
export const TASK_LIST_STATUS = {
  ACTIVE: 'active',
  ALL: 'all',
} as const;
export type TaskListStatus = import('./lifecycle-status.js').RunStatus | TaskStatus | typeof TASK_LIST_STATUS[keyof typeof TASK_LIST_STATUS];
export type TaskKind = 'quick';

export function hasLiveForegroundOwner(task: TaskEntry): boolean {
  const owner = task.foregroundOwner;
  // Unobservable identity cannot authorize another executor or display creator.
  return !!owner && processLiveness(owner.pid, owner.processStart) !== 'dead';
}

/** Startup settings are data; retired CLI spellings are consumed only at ingress. */
export interface TaskLaunchOptions {
  adapter?: string;
  workflow?: string;
  maxIterations?: number;
  campaign?: string;
  noCampaign?: boolean;
  campaignContext?: 'inherit' | 'skip';
}

export const DEFAULT_MAX_ATTEMPTS = 2;

export function normalizeLaunchOptions(args: string[]): TaskLaunchOptions {
  const launch: TaskLaunchOptions = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const value = () => inline ?? args[++i];
    if (flag === '--adapter') launch.adapter = value();
    else if (flag === '--workflow') launch.workflow = value();
    else if (flag === '--max-iterations') launch.maxIterations = Number(value());
    else if (flag === '--campaign') launch.campaign = value();
    else if (flag === '--no-campaign') launch.noCampaign = true;
    else if (flag === '--campaign-context') launch.campaignContext = value() as 'inherit' | 'skip';
    else if (flag === '--no-inherit-campaign') launch.campaignContext = 'skip';
    else if (['--timeout', '--existing-run-id', '--task', '--brief-input-base64', '--project', '--brief-admission-record'].includes(flag)) value();
  }
  if (launch.workflow === 'default') launch.workflow = 'planner';
  return launch;
}

/** Read aliases once; new records contain only the canonical fields. */
export function normalizeTaskEntry(raw: TaskEntry & {
  launch_seq?: number; max_retries?: number; launch_args?: string[];
}): TaskEntry {
  const { launch_seq, max_retries, launch_args, ...task } = raw;
  return {
    ...task,
    launch: task.launch ?? (launch_seq ?? (task.attempt ?? 1) - 1) + 1,
    max_attempts: task.max_attempts ?? max_retries ?? DEFAULT_MAX_ATTEMPTS,
    launch_options: task.launch_options
      ? { ...task.launch_options, ...(task.launch_options.workflow === 'default' ? { workflow: 'planner' } : {}) }
      : normalizeLaunchOptions(launch_args ?? []),
  };
}

export interface TaskEntry {
  /** Explicit launch-side address; never inherited from a daemon/worker. */
  launcher?: LaunchTarget;
  /** The foreground CLI owns execution and push until this exact process exits. */
  foregroundOwner?: { pid: number; processStart?: ProcessStartToken };
  id: number;
  name: string;
  kind?: TaskKind;
  brief_path?: string;
  brief_text?: string;
  brief_admission?: BriefAdmissionRecord;
  config_path?: string;
  projectDir: string;
  systemd_unit: string;
  run_id?: string;
  status: TaskStatus;
  attempt: number;
  /** Actual launch, starting at one; independent of retry budget consumption. */
  launch: number;
  max_attempts: number;
  commit_prefix?: string;
  expected_artifacts?: string[];
  expected_summary_path?: string;
  summary_one_liner?: string;
  summary_full?: string;
  summary_source?: string;
  summary_parsed_at?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  completing_commit?: string;
  notes?: string;
  tick_log_path: string;
  launch_options?: TaskLaunchOptions;
  /** ISO time before which a 'deferred' task must not be launched (backoff / project-busy wait). */
  not_before?: string;
  /** Why the task is deferred — surfaced in `task list` so a waiting task never looks hung. */
  defer_reason?: string;
  /** 'wait' = never launched, launch as-is when free. 'retry' = its unit already ran and
   *  failed, so the drain must consume an attempt and mint a fresh unit name (systemd
   *  refuses to reuse a transient unit name, and that refusal degrades silently). */
  defer_kind?: 'wait' | 'retry';
}

export function sessionTaskIndexPath(baseDir: string, launcher: Pick<LaunchTarget, 'frontend' | 'sessionId'>): string {
  const key = createHash('sha256').update(JSON.stringify([launcher.frontend, launcher.sessionId])).digest('hex');
  return join(baseDir, 'session-push', 'task-index', `${key}.json`);
}

export interface TaskCreateInput {
  launcher?: LaunchTarget;
  foregroundOwner?: TaskEntry['foregroundOwner'];
  name?: string;
  kind?: 'quick';
  brief_path?: string;
  brief_text?: string;
  brief_admission?: BriefAdmissionRecord;
  projectDir: string;
  systemd_unit?: string;
  run_id?: string;
  status?: TaskStatus;
  attempt?: number;
  launch?: number;
  max_attempts?: number;
  /** Legacy registration aliases; never written. */
  launch_seq?: number;
  max_retries?: number;
  commit_prefix?: string;
  expected_artifacts?: string[];
  expected_summary_path?: string;
  notes?: string;
  launch_options?: TaskLaunchOptions;
  launch_args?: string[];
}

export interface TaskListFilter {
  status?: TaskListStatus;
  limit?: number;
}

export interface TaskTick {
  ts?: string;
  status: string;
  message?: string;
  stages?: unknown;
}

export interface TaskRegistryHealth {
  unreadableRecords: number;
}

export interface TaskRegistrySnapshot extends TaskRegistryHealth {
  tasks: TaskEntry[];
}

// Explicit doctor diagnostics; ordinary registry writes never compact history.
export const REGISTRY_COMPACTION_THRESHOLDS = {
  bytes: 64 * 1024 * 1024,
  records: 10_000,
} as const;

export interface TaskRegistryMetrics extends TaskRegistryHealth {
  bytes: number;
  records: number;
  tasks: number;
  activeTasks: number;
  compactRecommended: boolean;
}

export type RegistryMaintenanceActionKind = 'repair' | 'quarantine' | 'drop-obsolete' | 'drop-blank';

export interface RegistryMaintenanceAction {
  kind: RegistryMaintenanceActionKind;
  line: number;
  taskId?: number;
  detail: string;
}

export interface RegistryMaintenanceReport {
  operation: 'repair' | 'compact';
  applied: boolean;
  changed: boolean;
  registryPath: string;
  backupPath?: string;
  quarantinePath?: string;
  repairedRecords: number;
  quarantinedRecords: number;
  removedRecords: number;
  actions: RegistryMaintenanceAction[];
  before: TaskRegistryMetrics;
  after: TaskRegistryMetrics;
}

export interface RegistryMaintenanceOptions {
  /** Maintenance is deliberately dry-run unless the caller opts in. */
  apply?: boolean;
}

export interface TaskRegistryOptions {
  baseDir?: string;
  now?: () => Date;
  /** Maximum time to wait for an active registry owner. Production default: 5 seconds. */
  lockTimeoutMs?: number;
  lockPollMs?: number;
  warn?: (message: string) => void;
  /** Fault-injection seam. Returning means the append is durable and may be acknowledged. */
  syncFile?: (fd: number) => void;
}

export class TaskRegistryIntegrityError extends Error {
  readonly unreadableRecords: number;
  readonly registryPath: string;

  constructor(registryPath: string, unreadableRecords: number) {
    super(
      `Task registry integrity check failed: ${registryPath} has ${unreadableRecords} unreadable `
      + `record${unreadableRecords === 1 ? '' : 's'}; refusing to update from an older snapshot. `
      + 'Run `flowcrew doctor --repair-registry` to preview a backup-first repair, then '
      + '`flowcrew doctor --repair-registry --apply` to preserve damaged rows in quarantine and repair the registry.',
    );
    this.name = 'TaskRegistryIntegrityError';
    this.registryPath = registryPath;
    this.unreadableRecords = unreadableRecords;
  }
}

interface RegistryReadResult extends TaskRegistryHealth {
  tasks: ReadonlyMap<number, TaskEntry>;
  activeTasks: ReadonlyMap<number, TaskEntry>;
  unknownTaskStatuses: boolean;
  /** True only when the unreadable record is the unacknowledged final fragment. */
  unreadableTail: boolean;
}

interface RegistryCache {
  dev: number;
  ino: number;
  readOffset: number;
  fileSize: number;
  mtimeMs: number;
  ctimeMs: number;
  pending: Buffer;
  pendingReadable: boolean;
  pendingTask?: TaskEntry;
  completeUnreadableRecords: number;
  completeRecords: number;
  tasks: Map<number, TaskEntry>;
  activeTasks: Map<number, TaskEntry>;
  unknownTaskIds: Set<number>;
}

interface TickProjection {
  status: string;
  message?: string;
  stages?: Record<string, unknown>;
}

interface PhysicalRegistryLine {
  line: number;
  raw: string;
  trimmed: string;
  value?: unknown;
  unreadable: boolean;
}

interface TornRowRecovery {
  task: TaskEntry;
  suffix: string;
}

interface RepairPlan {
  output: string;
  quarantine: string;
  actions: RegistryMaintenanceAction[];
  repairedRecords: number;
  quarantinedRecords: number;
  before: TaskRegistryMetrics;
  after: TaskRegistryMetrics;
}

interface CompactPlan {
  output: string;
  actions: RegistryMaintenanceAction[];
  removedRecords: number;
  before: TaskRegistryMetrics;
  after: TaskRegistryMetrics;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 10;

export function defaultFcDir(): string {
  return fcGlobalDir();
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, end - Date.now()));
  }
}

export class TaskRegistry {
  readonly baseDir: string;
  readonly registryPath: string;
  readonly seqPath: string;
  readonly tasksDir: string;
  readonly lockPath: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly warn: (message: string) => void;
  private readonly syncFile: (fd: number) => void;
  private registryCache?: RegistryCache;
  private readonly tickProjections = new Map<number, TickProjection>();

  constructor(opts: TaskRegistryOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultFcDir();
    this.registryPath = join(this.baseDir, 'tasks.jsonl');
    this.seqPath = join(this.baseDir, 'tasks-seq');
    this.tasksDir = join(this.baseDir, 'tasks');
    this.lockPath = join(this.baseDir, 'tasks.lock');
    this.now = opts.now ?? (() => new Date());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockPollMs = opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.syncFile = opts.syncFile ?? fsyncSync;
    mkdirSync(this.tasksDir, { recursive: true });
  }

  create(input: TaskCreateInput): TaskEntry {
    if (input.kind !== undefined && input.kind !== 'quick') {
      throw new Error('Campaign automation was retired; launch an admitted brief with quick --campaign <name>.');
    }
    return this.withLock(() => {
      const registry = this.readLatestUnlocked();
      // A complete damaged historical row cannot be mistaken for a partially
      // written newer value, so allocating a new id and appending is safe. A
      // torn tail is different: appending would acknowledge ambiguous bytes.
      if (registry.unreadableTail) {
        throw new TaskRegistryIntegrityError(this.registryPath, registry.unreadableRecords);
      }
      const id = this.nextIdUnlocked();
      const taskDir = join(this.tasksDir, String(id));
      mkdirSync(taskDir, { recursive: true });
      const brief = input.brief_text ?? input.brief_path ?? '';
      const name = input.name ?? (brief.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').slice(0, 80) || `Task ${id}`);
      const briefPath = input.brief_text === undefined
        ? input.brief_path
        : this.writeBriefSidecar(id, input.brief_text);
      const entry: TaskEntry = normalizeTaskEntry({
        launcher: input.launcher,
        foregroundOwner: input.foregroundOwner,
        id,
        name,
        kind: 'quick',
        brief_path: briefPath,
        brief_admission: input.brief_admission,
        projectDir: input.projectDir,
        systemd_unit: input.systemd_unit ?? `flowcrew-task-${id}.service`,
        run_id: input.run_id,
        status: input.status ?? TASK_STATUS.PENDING,
        attempt: input.attempt ?? 1,
        launch: input.launch ?? (input.launch_seq ?? (input.attempt ?? 1) - 1) + 1,
        max_attempts: input.max_attempts ?? input.max_retries ?? DEFAULT_MAX_ATTEMPTS,
        commit_prefix: input.commit_prefix,
        expected_artifacts: input.expected_artifacts,
        expected_summary_path: input.expected_summary_path,
        created_at: this.now().toISOString(),
        notes: input.notes,
        tick_log_path: join(taskDir, 'tick_log.md'),
        launch_options: input.launch_options ?? normalizeLaunchOptions(input.launch_args ?? []),
      });
      this.appendEntry(entry, { allowCompleteUnreadable: true });
      return structuredClone(entry);
    });
  }

  list(filter: TaskListFilter = {}): TaskEntry[] {
    return this.withLock(() => {
      // Select inside the coherent locked cache; only mutable public results
      // need copies. Terminal payloads never cross an active-list boundary.
      const registry = this.readLatestUnlocked();
      const selected = filter.status === TASK_LIST_STATUS.ACTIVE ? registry.activeTasks : registry.tasks;
      let tasks = Array.from(selected.values()).filter((task) => (
        !filter.status || filter.status === TASK_LIST_STATUS.ALL
          || (filter.status === TASK_LIST_STATUS.ACTIVE
            ? isActiveTaskStatus(task.status) : task.status === filter.status)
      )).sort((a, b) => a.id - b.id);
      if (filter.limit && filter.limit > 0) tasks = tasks.slice(-filter.limit);
      return tasks.map((task) => structuredClone(task));
    });
  }

  get(id: number): TaskEntry | undefined {
    return this.withLock(() => {
      const task = this.readLatestUnlocked().tasks.get(id);
      return task ? structuredClone(task) : undefined;
    });
  }

  update(id: number, patch: Partial<Omit<TaskEntry, 'id' | 'created_at' | 'tick_log_path'>>): TaskEntry {
    return this.withLock(() => {
      const registry = this.readLatestUnlocked();
      if (registry.unreadableRecords > 0) {
        throw new TaskRegistryIntegrityError(this.registryPath, registry.unreadableRecords);
      }
      const current = registry.tasks.get(id);
      if (!current) throw new Error(`Task not found: ${id}`);
      const next = this.externalizeInlineBrief({
        ...current,
        ...patch,
        id: current.id,
        created_at: current.created_at,
        tick_log_path: current.tick_log_path,
      });
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return structuredClone(current);
      }
      this.appendEntry(next);
      return structuredClone(next);
    });
  }

  snapshot(): TaskRegistrySnapshot {
    return this.withLock(() => {
      const registry = this.readLatestUnlocked();
      return {
        tasks: Array.from(registry.tasks.values())
          .sort((a, b) => a.id - b.id)
          .map((task) => structuredClone(task)),
        unreadableRecords: registry.unreadableRecords,
      };
    });
  }

  /** A writer cannot infer missing ownership from an unknown task lifecycle. */
  hasUnknownTaskStatuses(): boolean {
    return this.withLock(() => this.readLatestUnlocked().unknownTaskStatuses);
  }

  /** Serialize orphan recovery with binding writers. Acquire registry before
   * run-state locks; recover must be synchronous and must not reenter registry
   * methods. Refresh at each publication to veto observed non-locking appends.
   * A released list/health snapshot cannot authorize a run-state write. */
  withUnboundRun(
    runId: string,
    resolveBinding: (binding: string) => string,
    recover: (assertUnbound: () => void) => void,
  ): void {
    this.withLock(() => {
      const token = this.inspectLock()?.owner?.token;
      const assertUnbound = (): void => {
        if (!token || this.inspectLock()?.owner?.token !== token) {
          throw new Error('RECOVERY_REGISTRY_CHANGED: registry lock ownership changed');
        }
        const registry = this.readLatestUnlocked();
        if (registry.unreadableRecords || registry.unknownTaskStatuses) {
          throw new Error('RECOVERY_REGISTRY_UNKNOWN: registry cannot establish orphan ownership');
        }
        for (const task of registry.activeTasks.values()) {
          if (!task.run_id) continue;
          let bound: string;
          try { bound = resolveBinding(task.run_id); }
          catch { throw new Error('RECOVERY_REGISTRY_UNKNOWN: active run binding is unreadable'); }
          if (bound === runId) throw new Error('RECOVERY_REGISTRY_BOUND: run acquired an active task binding');
        }
      };
      assertUnbound();
      recover(assertUnbound);
    });
  }

  health(): TaskRegistryHealth {
    return this.withLock(() => ({ unreadableRecords: this.readLatestUnlocked().unreadableRecords }));
  }

  metrics(): TaskRegistryMetrics {
    return this.withLock(() => this.metricsFromCache(this.readLatestUnlocked()));
  }

  /**
   * Recover provably complete task rows embedded after a same-id torn prefix,
   * and quarantine every other unreadable physical row. This is a dry-run
   * unless `apply: true` is explicit.
   */
  repair(options: RegistryMaintenanceOptions = {}): RegistryMaintenanceReport {
    return this.withLock(() => {
      const sourceBytes = this.readRegistryBytes();
      const raw = sourceBytes.toString('utf-8');
      const plan = this.planRepair(raw);
      const changed = plan.actions.length > 0;
      const backupPath = changed ? this.availableEvidencePath('backup') : undefined;
      const quarantinePath = plan.quarantinedRecords > 0
        ? this.availableEvidencePath('quarantine', '.jsonl')
        : undefined;

      if (options.apply && changed) {
        this.createVerifiedBackup(backupPath!, sourceBytes);
        if (quarantinePath) this.writeAtomic(quarantinePath, plan.quarantine);
        this.writeAtomic(this.registryPath, plan.output);
        const afterWrite = this.metricsFromRaw(this.readRegistryRaw());
        if (afterWrite.unreadableRecords !== 0) {
          this.writeAtomic(this.registryPath, readFileSync(backupPath!));
          throw new Error(
            `Registry repair validation failed: ${afterWrite.unreadableRecords} unreadable record(s) remain. `
            + `The original registry was restored from ${backupPath}.`,
          );
        }
      }

      if (options.apply) {
        const tasks = this.readLatestUnlocked().tasks;
        this.writeSessionTaskIndexes(tasks, [...tasks.values()].flatMap((task) => task.launcher ? [task.launcher] : []));
      }

      return {
        operation: 'repair',
        applied: Boolean(options.apply && changed),
        changed,
        registryPath: this.registryPath,
        backupPath,
        quarantinePath,
        repairedRecords: plan.repairedRecords,
        quarantinedRecords: plan.quarantinedRecords,
        removedRecords: plan.quarantinedRecords,
        actions: plan.actions,
        before: plan.before,
        after: plan.after,
      };
    });
  }

  /**
   * Rewrite the append-only registry to the last complete row per task id.
   * `readLatest()` already folds history this way, so the operation is
   * semantically neutral. Corrupt input remains fail-closed and must be
   * repaired first. Dry-run is the default.
   */
  compact(options: RegistryMaintenanceOptions = {}): RegistryMaintenanceReport {
    return this.withLock(() => {
      const sourceBytes = this.readRegistryBytes();
      const raw = sourceBytes.toString('utf-8');
      const plan = this.planCompact(raw);
      const changed = plan.output !== raw;
      const backupPath = changed ? this.availableEvidencePath('backup') : undefined;

      if (options.apply && changed) {
        this.createVerifiedBackup(backupPath!, sourceBytes);
        this.writeAtomic(this.registryPath, plan.output);
        const afterRaw = this.readRegistryRaw();
        const afterWrite = this.metricsFromRaw(afterRaw);
        const beforeTasks = this.latestTasksFromRaw(raw);
        const afterTasks = this.latestTasksFromRaw(afterRaw);
        if (
          afterWrite.unreadableRecords !== 0
          || afterWrite.records !== afterWrite.tasks
          || !isDeepStrictEqual(beforeTasks, afterTasks)
        ) {
          this.writeAtomic(this.registryPath, readFileSync(backupPath!));
          throw new Error(
            `Registry compaction validation failed; the original registry was restored from ${backupPath}.`,
          );
        }
      }

      return {
        operation: 'compact',
        applied: Boolean(options.apply && changed),
        changed,
        registryPath: this.registryPath,
        backupPath,
        repairedRecords: 0,
        quarantinedRecords: 0,
        removedRecords: plan.removedRecords,
        actions: plan.actions,
        before: plan.before,
        after: plan.after,
      };
    });
  }

  appendTick(id: number, tick: TaskTick): void {
    const task = this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    mkdirSync(dirname(task.tick_log_path), { recursive: true });
    const stages = tick.stages === undefined ? undefined : this.compactStages(tick.stages);
    const previous = this.tickProjections.get(id);
    const current: TickProjection = {
      status: tick.status,
      ...(tick.message ? { message: tick.message } : {}),
      ...(stages ? { stages } : {}),
    };
    if (previous && isDeepStrictEqual(previous, current)) return;

    const stageDelta = stages ? this.diffStages(previous?.stages, stages) : undefined;
    const ts = tick.ts ?? this.now().toISOString();
    const parts = [`- ${ts} status=${tick.status}`];
    if (tick.message) parts.push(` ${tick.message}`);
    if (stageDelta && Object.keys(stageDelta).length > 0) {
      parts.push(` stage_delta=${JSON.stringify(stageDelta)}`);
    }
    appendFileSync(task.tick_log_path, `${parts.join('')}\n`, 'utf-8');
    this.tickProjections.set(id, current);
  }

  readRecentTicks(id: number, limit = 20): string[] {
    const task = this.get(id);
    if (!task || !existsSync(task.tick_log_path)) return [];
    if (limit <= 0) return [];
    let fd: number | undefined;
    try {
      fd = openSync(task.tick_log_path, 'r');
      const size = fstatSync(fd).size;
      const chunks: Buffer[] = [];
      let offset = size;
      let newlineCount = 0;
      while (offset > 0 && newlineCount <= limit) {
        const length = Math.min(64 * 1024, offset);
        offset -= length;
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = readSync(fd, chunk, 0, length, offset);
        const used = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
        chunks.unshift(used);
        for (const byte of used) if (byte === 0x0a) newlineCount += 1;
      }
      const lines = Buffer.concat(chunks).toString('utf-8').split(/\r?\n/).filter(Boolean);
      return lines.slice(Math.max(0, lines.length - limit));
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    }
  }

  private compactStages(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const compact: Record<string, unknown> = {};
    for (const stageId of Object.keys(value as Record<string, unknown>).sort()) {
      const raw = (value as Record<string, unknown>)[stageId];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const stage = raw as Record<string, unknown>;
      const projection: Record<string, unknown> = {};
      for (const key of ['status', 'retries', 'reruns', 'startedAt', 'completedAt', 'error'] as const) {
        const candidate = stage[key];
        if (typeof candidate === 'number') projection[key] = candidate;
        else if (typeof candidate === 'string') {
          projection[key] = key === 'error' && candidate.length > 500 ? `${candidate.slice(0, 497)}...` : candidate;
        }
      }
      if (Array.isArray(stage.attempts)) projection.executions = stage.attempts.length;
      compact[stageId] = projection;
    }
    return compact;
  }

  private diffStages(
    previous: Record<string, unknown> | undefined,
    current: Record<string, unknown>,
  ): Record<string, unknown> {
    const delta: Record<string, unknown> = {};
    for (const stageId of new Set([...Object.keys(previous ?? {}), ...Object.keys(current)])) {
      if (!(stageId in current)) delta[stageId] = null;
      else if (!previous || !isDeepStrictEqual(previous[stageId], current[stageId])) delta[stageId] = current[stageId];
    }
    return delta;
  }

  private readRegistryRaw(): string {
    return existsSync(this.registryPath) ? readFileSync(this.registryPath, 'utf-8') : '';
  }

  private readRegistryBytes(): Buffer {
    return existsSync(this.registryPath) ? readFileSync(this.registryPath) : Buffer.alloc(0);
  }

  private physicalLines(raw: string): PhysicalRegistryLine[] {
    if (raw.length === 0) return [];
    const lines = raw.split('\n');
    if (raw.endsWith('\n')) lines.pop();
    return lines.map((lineRaw, index) => {
      const trimmed = lineRaw.trim();
      if (!trimmed) return { line: index + 1, raw: lineRaw, trimmed, unreadable: false };
      try {
        return { line: index + 1, raw: lineRaw, trimmed, value: JSON.parse(trimmed) as unknown, unreadable: false };
      } catch {
        return { line: index + 1, raw: lineRaw, trimmed, unreadable: true };
      }
    });
  }

  private metricsFromRaw(raw: string): TaskRegistryMetrics {
    const lines = this.physicalLines(raw);
    const tasks = new Map<number, TaskEntry>();
    let unreadableRecords = 0;
    let records = 0;
    for (const line of lines) {
      if (!line.trimmed) continue;
      records += 1;
      if (line.unreadable) {
        unreadableRecords += 1;
        continue;
      }
      if (line.value && typeof line.value === 'object') {
        const task = normalizeTaskEntry(line.value as TaskEntry);
        if (typeof task.id === 'number') tasks.set(task.id, task);
      }
    }
    const bytes = Buffer.byteLength(raw);
    return {
      bytes,
      records,
      tasks: tasks.size,
      activeTasks: Array.from(tasks.values()).filter((task) => isActiveTaskStatus(task.status)).length,
      unreadableRecords,
      compactRecommended: bytes >= REGISTRY_COMPACTION_THRESHOLDS.bytes
        || records >= REGISTRY_COMPACTION_THRESHOLDS.records,
    };
  }

  private metricsFromCache(registry: RegistryReadResult): TaskRegistryMetrics {
    const cache = this.registryCache;
    const hasPendingRecord = Boolean(cache && cache.pending.toString('utf-8').trim().length > 0);
    const records = (cache?.completeRecords ?? 0) + (hasPendingRecord ? 1 : 0);
    const bytes = cache?.fileSize ?? 0;
    return {
      bytes,
      records,
      tasks: registry.tasks.size,
      activeTasks: registry.activeTasks.size,
      unreadableRecords: registry.unreadableRecords,
      compactRecommended: bytes >= REGISTRY_COMPACTION_THRESHOLDS.bytes
        || records >= REGISTRY_COMPACTION_THRESHOLDS.records,
    };
  }

  private latestTasksFromRaw(raw: string): TaskEntry[] {
    const tasks = new Map<number, TaskEntry>();
    for (const line of this.physicalLines(raw)) {
      if (line.unreadable || !line.value || typeof line.value !== 'object') continue;
      const task = normalizeTaskEntry(line.value as TaskEntry);
      if (typeof task.id === 'number') tasks.set(task.id, task);
    }
    return Array.from(tasks.values()).sort((left, right) => left.id - right.id);
  }

  private planRepair(raw: string): RepairPlan {
    const outputLines: string[] = [];
    const quarantineRows: string[] = [];
    const actions: RegistryMaintenanceAction[] = [];
    let repairedRecords = 0;
    let quarantinedRecords = 0;

    for (const line of this.physicalLines(raw)) {
      if (!line.unreadable) {
        outputLines.push(line.raw);
        continue;
      }
      const recovery = this.recoverTornRow(line.trimmed);
      if (recovery) {
        outputLines.push(recovery.suffix);
        repairedRecords += 1;
        actions.push({
          kind: 'repair',
          line: line.line,
          taskId: recovery.task.id,
          detail: `remove the truncated prefix and retain the complete task #${recovery.task.id} record`,
        });
        continue;
      }
      quarantinedRecords += 1;
      quarantineRows.push(JSON.stringify({ line: line.line, raw: line.raw }));
      actions.push({
        kind: 'quarantine',
        line: line.line,
        detail: 'move the unreadable row to quarantine; the evidence backup retains the original byte-for-byte file',
      });
    }

    // Every non-empty JSONL rewrite must end with a record separator. A torn
    // final write commonly leaves no trailing newline; preserving that shape
    // would make the next append concatenate two valid JSON objects and
    // immediately corrupt the repaired registry again.
    const output = outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '';
    const quarantine = quarantineRows.length > 0 ? `${quarantineRows.join('\n')}\n` : '';
    return {
      output,
      quarantine,
      actions,
      repairedRecords,
      quarantinedRecords,
      before: this.metricsFromRaw(raw),
      after: this.metricsFromRaw(output),
    };
  }

  private recoverTornRow(line: string): TornRowRecovery | undefined {
    const candidates: TornRowRecovery[] = [];
    for (let index = line.indexOf('{', 1); index >= 0; index = line.indexOf('{', index + 1)) {
      const prefix = line.slice(0, index);
      if (!prefix.trimStart().startsWith('{')) continue;
      const suffix = line.slice(index).trim();
      let value: unknown;
      try { value = JSON.parse(suffix) as unknown; } catch { continue; }
      if (!this.isCompleteTaskRecord(value)) continue;
      const prefixIds = Array.from(prefix.matchAll(/"id"\s*:\s*(\d+)/g), (match) => Number.parseInt(match[1], 10));
      if (prefixIds.length === 0 || prefixIds.some((id) => id !== value.id)) continue;
      candidates.push({ task: value, suffix });
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private isCompleteTaskRecord(value: unknown): value is TaskEntry {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<TaskEntry> & { max_retries?: number };
    return Number.isInteger(row.id)
      && typeof row.name === 'string'
      && typeof row.projectDir === 'string'
      && typeof row.systemd_unit === 'string'
      && typeof row.status === 'string'
      && typeof row.attempt === 'number'
      && typeof (row.max_attempts ?? row.max_retries) === 'number'
      && typeof row.created_at === 'string'
      && typeof row.tick_log_path === 'string';
  }

  private planCompact(raw: string): CompactPlan {
    const lines = this.physicalLines(raw);
    const before = this.metricsFromRaw(raw);
    if (before.unreadableRecords > 0) {
      throw new TaskRegistryIntegrityError(this.registryPath, before.unreadableRecords);
    }

    const taskRows: Array<{ line: number; raw: string; task: TaskEntry }> = [];
    const blankLines: PhysicalRegistryLine[] = [];
    for (const line of lines) {
      if (!line.trimmed) {
        blankLines.push(line);
        continue;
      }
      if (
        !line.value
        || typeof line.value !== 'object'
        || typeof (line.value as { id?: unknown }).id !== 'number'
      ) {
        throw new Error(
          `Task registry compaction refused: line ${line.line} is valid JSON but has no numeric task id. `
          + 'Preserve and inspect that row before compacting.',
        );
      }
      // Preserve historical row shapes exactly. readLatest() only requires a
      // numeric id and deliberately does not migrate or normalize fields.
      taskRows.push({ line: line.line, raw: line.raw, task: line.value as TaskEntry });
    }

    const lastById = new Map<number, { line: number; raw: string; task: TaskEntry }>();
    for (const row of taskRows) lastById.set(row.task.id, row);
    const kept = Array.from(lastById.values()).sort((left, right) => left.line - right.line);
    // Compaction also normalizes the JSONL record separator so a valid legacy
    // file without a final newline remains append-safe after maintenance.
    const output = kept.length > 0 ? `${kept.map((row) => row.raw).join('\n')}\n` : '';
    const actions: RegistryMaintenanceAction[] = [];
    for (const row of taskRows) {
      const retained = lastById.get(row.task.id)!;
      if (retained.line === row.line) continue;
      actions.push({
        kind: 'drop-obsolete',
        line: row.line,
        taskId: row.task.id,
        detail: `remove obsolete task #${row.task.id} version; retain its last record from line ${retained.line}`,
      });
    }
    for (const line of blankLines) {
      actions.push({ kind: 'drop-blank', line: line.line, detail: 'remove blank physical line during compaction' });
    }

    const beforeTasks = this.latestTasksFromRaw(raw);
    const afterTasks = this.latestTasksFromRaw(output);
    const after = this.metricsFromRaw(output);
    if (!isDeepStrictEqual(beforeTasks, afterTasks) || after.records !== after.tasks) {
      throw new Error('Task registry compaction planning failed its semantic-equivalence check; no files were changed.');
    }
    return {
      output,
      actions,
      removedRecords: before.records - after.records,
      before,
      after,
    };
  }

  private availableEvidencePath(kind: 'backup' | 'quarantine', extension = ''): string {
    const stamp = this.now().toISOString().replace(/[-:.]/g, '');
    const stem = `${this.registryPath}.${kind}-${stamp}`;
    let candidate = `${stem}${extension}`;
    for (let suffix = 1; existsSync(candidate); suffix += 1) candidate = `${stem}-${suffix}${extension}`;
    return candidate;
  }

  private createVerifiedBackup(path: string, sourceBytes: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(this.registryPath, path, constants.COPYFILE_EXCL);
    const copied = readFileSync(path);
    if (!copied.equals(sourceBytes)) {
      throw new Error(`Registry evidence backup verification failed at ${path}; registry was not rewritten.`);
    }
  }

  private writeAtomic(path: string, content: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    // Registry records and brief sidecars are durable task/recovery inputs.
    atomicWrite(path, content, { durability: 'durable' });
  }

  private readLatestUnlocked(): RegistryReadResult {
    let fd: number | undefined;
    try {
      fd = openSync(this.registryPath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.registryCache = undefined;
      return { tasks: new Map(), activeTasks: new Map(), unknownTaskStatuses: false, unreadableRecords: 0, unreadableTail: false };
    }

    try {
      const stat = fstatSync(fd);
      const cached = this.registryCache;
      const sameIdentity = cached?.dev === stat.dev && cached.ino === stat.ino;
      const sameSizeWasRewritten = Boolean(
        cached
        && sameIdentity
        && stat.size === cached.readOffset
        && (stat.mtimeMs !== cached.mtimeMs || stat.ctimeMs !== cached.ctimeMs),
      );
      const rebuild = !cached
        || !sameIdentity
        || stat.size < cached.readOffset
        || sameSizeWasRewritten;
      if (rebuild) {
        this.registryCache = {
          dev: stat.dev,
          ino: stat.ino,
          readOffset: 0,
          fileSize: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          pending: Buffer.alloc(0),
          pendingReadable: true,
          completeUnreadableRecords: 0,
          completeRecords: 0,
          tasks: new Map(),
          activeTasks: new Map(),
          unknownTaskIds: new Set(),
        };
      }

      const cache = this.registryCache!;
      if (stat.size > cache.readOffset) {
        const chunk = Buffer.allocUnsafe(stat.size - cache.readOffset);
        let consumed = 0;
        while (consumed < chunk.length) {
          const count = readSync(fd, chunk, consumed, chunk.length - consumed, cache.readOffset + consumed);
          if (count === 0) break;
          consumed += count;
        }
        const bytes = consumed === chunk.length ? chunk : chunk.subarray(0, consumed);
        this.applyRegistryBytes(cache, bytes);
        cache.readOffset += consumed;
      }
      const after = fstatSync(fd);
      cache.fileSize = after.size;
      cache.mtimeMs = after.mtimeMs;
      cache.ctimeMs = after.ctimeMs;

      // No cache reference escapes the lock/public cloning boundary. A valid
      // unterminated tail remains an overlay until completed by an append.
      const tasks = cache.pendingTask ? new Map(cache.tasks) : cache.tasks;
      const activeTasks = cache.pendingTask ? new Map(cache.activeTasks) : cache.activeTasks;
      if (cache.pendingTask) {
        tasks.set(cache.pendingTask.id, cache.pendingTask);
        if (isActiveTaskStatus(cache.pendingTask.status)) activeTasks.set(cache.pendingTask.id, cache.pendingTask);
        else activeTasks.delete(cache.pendingTask.id);
      }
      const pendingUnreadable = cache.pending.length > 0 && !cache.pendingReadable ? 1 : 0;
      return {
        tasks,
        activeTasks,
        unknownTaskStatuses: cache.pendingTask
          ? cache.unknownTaskIds.size - Number(cache.unknownTaskIds.has(cache.pendingTask.id))
            + Number(!isKnownTaskStatus(cache.pendingTask.status)) > 0
          : cache.unknownTaskIds.size > 0,
        unreadableRecords: cache.completeUnreadableRecords + pendingUnreadable,
        unreadableTail: pendingUnreadable > 0,
      };
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    }
  }

  private appendEntry(entry: TaskEntry, opts: { allowCompleteUnreadable?: boolean } = {}): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const current = this.readLatestUnlocked();
    if (current.unreadableRecords > 0 && !(opts.allowCompleteUnreadable && !current.unreadableTail)) {
      throw new TaskRegistryIntegrityError(this.registryPath, current.unreadableRecords);
    }
    const previousLauncher = current.tasks.get(entry.id)?.launcher;
    const cache = this.registryCache;
    const needsSeparator = Boolean(cache && cache.pending.length > 0 && cache.pending.toString('utf-8').trim().length > 0);
    const bytes = Buffer.from(`${needsSeparator ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf-8');
    const existed = existsSync(this.registryPath);
    let fd: number | undefined;
    try {
      fd = openSync(this.registryPath, 'a');
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error(`Task registry append made no progress for ${this.registryPath}`);
        written += count;
      }
      this.syncFile(fd);
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    }
    if (!existed) {
      let parent: number | undefined;
      try {
        parent = openSync(dirname(this.registryPath), 'r');
        fsyncSync(parent);
      } finally {
        try { if (parent !== undefined) closeSync(parent); } catch { /* best effort */ }
      }
    }
    // Acknowledgement follows sync. Folding the newly durable suffix keeps the
    // hot cache coherent without rereading any historical byte.
    const tasks = this.readLatestUnlocked().tasks;
    if (!existsSync(join(this.baseDir, 'session-push', 'task-index', 'ready'))) {
      this.writeSessionTaskIndexes(tasks, [...tasks.values()].flatMap(task => task.launcher ? [task.launcher] : []));
    } else if (!isDeepStrictEqual(previousLauncher, entry.launcher)) {
      this.writeSessionTaskIndexes(tasks, [previousLauncher, entry.launcher].filter((launcher): launcher is LaunchTarget => Boolean(launcher)));
    }
  }

  /** Bootstrap legacy launcher rows before trusting a missing session index. */
  ensureSessionTaskIndexes(): void {
    this.withLock(() => {
      if (existsSync(join(this.baseDir, 'session-push', 'task-index', 'ready'))) return;
      const tasks = this.readLatestUnlocked().tasks;
      this.writeSessionTaskIndexes(tasks, [...tasks.values()].flatMap((task) => task.launcher ? [task.launcher] : []));
    });
  }

  private writeSessionTaskIndexes(tasks: ReadonlyMap<number, TaskEntry>, launchers: LaunchTarget[]): void {
    const sessions = new Map(launchers.map((launcher) => [sessionTaskIndexPath(this.baseDir, launcher), [] as number[]]));
    for (const task of tasks.values()) {
      if (task.launcher) sessions.get(sessionTaskIndexPath(this.baseDir, task.launcher))?.push(task.id);
    }
    for (const [path, ids] of sessions) {
      const content = `${JSON.stringify(ids)}\n`;
      try { if (readFileSync(path, 'utf8') === content) continue; } catch { /* index not yet written */ }
      mkdirSync(dirname(path), { recursive: true });
      this.writeAtomic(path, content);
    }
    const ready = join(this.baseDir, 'session-push', 'task-index', 'ready');
    if (!existsSync(ready)) {
      mkdirSync(dirname(ready), { recursive: true });
      this.writeAtomic(ready, 'ready\n');
    }
  }

  private applyRegistryBytes(cache: RegistryCache, bytes: Buffer): void {
    const combined = cache.pending.length > 0 ? Buffer.concat([cache.pending, bytes]) : bytes;
    const finalNewline = combined.lastIndexOf(0x0a);
    const complete = finalNewline >= 0 ? combined.subarray(0, finalNewline) : Buffer.alloc(0);
    cache.pending = finalNewline >= 0 ? combined.subarray(finalNewline + 1) : Buffer.from(combined);

    if (complete.length > 0) {
      for (const rawLine of complete.toString('utf-8').split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        cache.completeRecords += 1;
        let value: unknown;
        try {
          value = JSON.parse(trimmed) as unknown;
        } catch {
          cache.completeUnreadableRecords += 1;
          continue;
        }
        if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'number') {
          const task = normalizeTaskEntry(value as TaskEntry);
          cache.tasks.set(task.id, task);
          // The same parsed row updates both views; no independent history scan.
          if (isActiveTaskStatus(task.status)) cache.activeTasks.set(task.id, task);
          else cache.activeTasks.delete(task.id);
          if (isKnownTaskStatus(task.status)) cache.unknownTaskIds.delete(task.id);
          else cache.unknownTaskIds.add(task.id);
        }
      }
    }

    cache.pendingTask = undefined;
    cache.pendingReadable = true;
    const pending = cache.pending.toString('utf-8').trim();
    if (!pending) return;
    try {
      const value = JSON.parse(pending) as unknown;
      if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'number') {
        cache.pendingTask = normalizeTaskEntry(value as TaskEntry);
      }
    } catch {
      cache.pendingReadable = false;
    }
  }

  private writeBriefSidecar(id: number, brief: string): string {
    const taskDir = join(this.tasksDir, String(id));
    const briefPath = join(taskDir, 'brief.md');
    this.writeAtomic(briefPath, brief);
    return briefPath;
  }

  private externalizeInlineBrief(entry: TaskEntry): TaskEntry {
    if (entry.brief_text === undefined) return entry;
    const next = { ...entry, brief_path: this.writeBriefSidecar(entry.id, entry.brief_text) };
    delete next.brief_text;
    return next;
  }

  private nextIdUnlocked(): number {
    mkdirSync(dirname(this.seqPath), { recursive: true });
    let current = 0;
    if (existsSync(this.seqPath)) {
      const raw = readFileSync(this.seqPath, 'utf-8').trim();
      current = Number.parseInt(raw, 10) || 0;
    }
    const next = current + 1;
    atomicWrite(this.seqPath, `${next}\n`, { durability: 'durable' });
    return next;
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(this.baseDir, { recursive: true });
    const started = Date.now();
    const token = randomUUID();
    for (;;) {
      try {
        publishLockOwner(this.lockPath, { ...lockOwnerIdentity(), acquiredAt: new Date().toISOString(), token });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const observed = this.inspectLock();
        const reason = observed && recoverStaleLock(observed, () => this.inspectLock(), () => unlinkSync(this.lockPath));
        if (reason) {
          const owner = observed.owner ? ` left by pid=${observed.owner.pid}` : '';
          try {
            this.warn(`TaskRegistry: took over stale lock${owner} at ${this.lockPath} (${reason}).`);
          } catch { /* diagnostics must not turn a successful recovery into another outage */ }
          continue;
        }
        if (Date.now() - started >= this.lockTimeoutMs) throw this.lockTimeoutError(observed);
        sleepSync(this.lockPollMs);
      }
    }
    try {
      return fn();
    } finally {
      try {
        const current = this.inspectLock();
        if (current?.owner?.token === token) unlinkSync(this.lockPath);
      } catch { /* best effort; an old owner must never remove a replacement owner's lock */ }
    }
  }

  private inspectLock(): LockObservation | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, 'r');
      const stat = fstatSync(fd);
      const raw = readFileSync(fd, 'utf-8');
      return {
        owner: parseLockOwner(raw),
        mtimeMs: stat.mtimeMs,
        signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    }
  }

  private lockTimeoutError(observed: LockObservation | undefined): Error {
    if (observed?.owner) {
      const since = observed.owner.acquiredAt ? ` since ${observed.owner.acquiredAt}` : '';
      return new Error(
        `Timed out after ${this.lockTimeoutMs}ms waiting for task registry lock ${this.lockPath}; `
        + `it is held by active pid=${observed.owner.pid}${since}. Wait for that process to finish or inspect it `
        + `with "ps -p ${observed.owner.pid}"; do not delete a live lock.`,
      );
    }
    return new Error(
      `Timed out after ${this.lockTimeoutMs}ms waiting for task registry lock ${this.lockPath}; owner metadata is unreadable. `
      + 'Wait for the writer to finish and confirm no process owns the lock before removing a stale lock.',
    );
  }
}
