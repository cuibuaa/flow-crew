import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJsonlFileWithDiagnostics } from './jsonl.js';
import { fcGlobalDir } from './store.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';

// 'deferred' — admitted but intentionally NOT launched yet (the project has a
// live run, or a backoff window is open). It is an ACTIVE state: the tick sweep
// must keep visiting it or the task silently never launches. Distinct from
// 'pending' (created, launch imminent) and from 'stuck' (needs a human).
export const TASK_STATUS = {
  PENDING: 'pending',
  DEFERRED: 'deferred',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  DONE: 'done',
  STUCK: 'stuck',
  NEEDS_SUMMARY: 'needs_summary',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  REALITY_GATE_FAILED: 'reality_gate_failed',
} as const;
export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS];

export const TASK_LIST_STATUS = {
  ACTIVE: 'active',
  ALL: 'all',
} as const;
export type TaskListStatus = TaskStatus | typeof TASK_LIST_STATUS[keyof typeof TASK_LIST_STATUS];

const ACTIVE_TASK_STATUSES = [
  TASK_STATUS.PENDING,
  TASK_STATUS.DEFERRED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.CANCELLING,
] as const;

export function isActiveTaskStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}
export type TaskKind = 'quick' | 'campaign';
export type TaskSummaryVerdict = 'PASS' | 'FAIL' | 'ESCALATE';

export interface TaskEntry {
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
  /** Monotonic actual-launch sequence, independent of retry budget consumption. */
  launch_seq?: number;
  max_retries: number;
  commit_prefix?: string;
  expected_artifacts?: string[];
  expected_summary_path?: string;
  summary_verdict?: TaskSummaryVerdict;
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
  launch_args?: string[];
  /** ISO time before which a 'deferred' task must not be launched (backoff / project-busy wait). */
  not_before?: string;
  /** Why the task is deferred — surfaced in `task list` so a waiting task never looks hung. */
  defer_reason?: string;
  /** 'wait' = never launched, launch as-is when free. 'retry' = its unit already ran and
   *  failed, so the drain must consume an attempt and mint a fresh unit name (systemd
   *  refuses to reuse a transient unit name, and that refusal degrades silently). */
  defer_kind?: 'wait' | 'retry';
}

export interface TaskCreateInput {
  name?: string;
  kind?: TaskKind;
  brief_path?: string;
  brief_text?: string;
  brief_admission?: BriefAdmissionRecord;
  config_path?: string;
  projectDir: string;
  systemd_unit?: string;
  run_id?: string;
  status?: TaskStatus;
  attempt?: number;
  launch_seq?: number;
  max_retries?: number;
  commit_prefix?: string;
  expected_artifacts?: string[];
  expected_summary_path?: string;
  notes?: string;
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

// Surface growth well before the observed 341 MiB / 28,551-record incident,
// while avoiding churn for ordinary E4-era sidecar-backed registries. This is
// an operator recommendation only: compaction remains explicit and dry-run.
export const REGISTRY_COMPACTION_THRESHOLDS = {
  bytes: 64 * 1024 * 1024,
  records: 10_000,
} as const;

export interface TaskRegistryMetrics extends TaskRegistryHealth {
  bytes: number;
  records: number;
  tasks: number;
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
  /** Age after which a lock can be recovered even if its recorded owner still exists. Production default: 30 seconds. */
  staleLockMs?: number;
  lockPollMs?: number;
  warn?: (message: string) => void;
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

interface RegistryLockOwner {
  pid: number;
  acquiredAt?: string;
  token?: string;
}

interface RegistryLockObservation {
  owner?: RegistryLockOwner;
  mtimeMs: number;
  signature: string;
}

interface RegistryReadResult extends TaskRegistryHealth {
  tasks: Map<number, TaskEntry>;
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
const DEFAULT_STALE_LOCK_MS = 30_000;
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
  private readonly staleLockMs: number;
  private readonly lockPollMs: number;
  private readonly warn: (message: string) => void;

  constructor(opts: TaskRegistryOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultFcDir();
    this.registryPath = join(this.baseDir, 'tasks.jsonl');
    this.seqPath = join(this.baseDir, 'tasks-seq');
    this.tasksDir = join(this.baseDir, 'tasks');
    this.lockPath = join(this.baseDir, 'tasks.lock');
    this.now = opts.now ?? (() => new Date());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.lockPollMs = opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    mkdirSync(this.tasksDir, { recursive: true });
  }

  create(input: TaskCreateInput): TaskEntry {
    return this.withLock(() => {
      const id = this.nextIdUnlocked();
      const taskDir = join(this.tasksDir, String(id));
      mkdirSync(taskDir, { recursive: true });
      const brief = input.brief_text ?? input.brief_path ?? input.config_path ?? '';
      const name = input.name ?? (brief.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').slice(0, 80) || `Task ${id}`);
      const briefPath = input.brief_text === undefined
        ? input.brief_path
        : this.writeBriefSidecar(id, input.brief_text);
      const entry: TaskEntry = {
        id,
        name,
        kind: input.kind ?? (input.config_path ? 'campaign' : 'quick'),
        brief_path: briefPath,
        brief_admission: input.brief_admission,
        config_path: input.config_path,
        projectDir: input.projectDir,
        systemd_unit: input.systemd_unit ?? `flowcrew-task-${id}.service`,
        run_id: input.run_id,
        status: input.status ?? TASK_STATUS.PENDING,
        attempt: input.attempt ?? 1,
        launch_seq: input.launch_seq,
        max_retries: input.max_retries ?? 2,
        commit_prefix: input.commit_prefix,
        expected_artifacts: input.expected_artifacts,
        expected_summary_path: input.expected_summary_path,
        created_at: this.now().toISOString(),
        notes: input.notes,
        tick_log_path: join(taskDir, 'tick_log.md'),
        launch_args: input.launch_args,
      };
      this.appendEntry(entry);
      return entry;
    });
  }

  list(filter: TaskListFilter = {}): TaskEntry[] {
    let tasks = this.snapshot().tasks;
    if (filter.status && filter.status !== TASK_LIST_STATUS.ALL) {
      // 'deferred' MUST be in the active set — it is the queue the tick sweep drains.
      if (filter.status === TASK_LIST_STATUS.ACTIVE) tasks = tasks.filter((t) => isActiveTaskStatus(t.status));
      else tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter.limit && filter.limit > 0) tasks = tasks.slice(-filter.limit);
    return tasks;
  }

  get(id: number): TaskEntry | undefined {
    return this.withLock(() => this.readLatestUnlocked().tasks.get(id));
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
      this.appendEntry(next);
      return next;
    });
  }

  snapshot(): TaskRegistrySnapshot {
    return this.withLock(() => {
      const registry = this.readLatestUnlocked();
      return {
        tasks: Array.from(registry.tasks.values()).sort((a, b) => a.id - b.id),
        unreadableRecords: registry.unreadableRecords,
      };
    });
  }

  health(): TaskRegistryHealth {
    return this.withLock(() => ({ unreadableRecords: this.readLatestUnlocked().unreadableRecords }));
  }

  metrics(): TaskRegistryMetrics {
    return this.withLock(() => this.metricsFromRaw(this.readRegistryRaw()));
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
    const ts = tick.ts ?? this.now().toISOString();
    const parts = [`- ${ts} status=${tick.status}`];
    if (tick.message) parts.push(` ${tick.message}`);
    if (tick.stages !== undefined) parts.push(` stages=${JSON.stringify(tick.stages)}`);
    appendFileSync(task.tick_log_path, `${parts.join('')}\n`, 'utf-8');
  }

  readRecentTicks(id: number, limit = 20): string[] {
    const task = this.get(id);
    if (!task || !existsSync(task.tick_log_path)) return [];
    const lines = readFileSync(task.tick_log_path, 'utf-8').split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - limit));
  }

  nextId(): number {
    return this.withLock(() => this.nextIdUnlocked());
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
        const task = line.value as TaskEntry;
        if (typeof task.id === 'number') tasks.set(task.id, task);
      }
    }
    const bytes = Buffer.byteLength(raw);
    return {
      bytes,
      records,
      tasks: tasks.size,
      unreadableRecords,
      compactRecommended: bytes >= REGISTRY_COMPACTION_THRESHOLDS.bytes
        || records >= REGISTRY_COMPACTION_THRESHOLDS.records,
    };
  }

  private latestTasksFromRaw(raw: string): TaskEntry[] {
    const tasks = new Map<number, TaskEntry>();
    for (const line of this.physicalLines(raw)) {
      if (line.unreadable || !line.value || typeof line.value !== 'object') continue;
      const task = line.value as TaskEntry;
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
    const row = value as Partial<TaskEntry>;
    return Number.isInteger(row.id)
      && typeof row.name === 'string'
      && typeof row.projectDir === 'string'
      && typeof row.systemd_unit === 'string'
      && typeof row.status === 'string'
      && typeof row.attempt === 'number'
      && typeof row.max_retries === 'number'
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
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, content, { flag: 'wx' });
      renameSync(tmp, path);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  private readLatestUnlocked(): RegistryReadResult {
    const tasks = new Map<number, TaskEntry>();
    if (!existsSync(this.registryPath)) return { tasks, unreadableRecords: 0 };
    const result = readJsonlFileWithDiagnostics<unknown>(this.registryPath);
    for (const row of result.rows) {
      if (!row || typeof row !== 'object') continue;
      const parsed = row as TaskEntry;
      if (typeof parsed.id === 'number') tasks.set(parsed.id, parsed);
    }
    return { tasks, unreadableRecords: result.unreadableRecords };
  }

  private appendEntry(entry: TaskEntry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    appendFileSync(this.registryPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private writeBriefSidecar(id: number, brief: string): string {
    const taskDir = join(this.tasksDir, String(id));
    const briefPath = join(taskDir, 'brief.md');
    const tmp = join(taskDir, `.brief.${process.pid}.${randomUUID()}.tmp`);
    mkdirSync(taskDir, { recursive: true });
    try {
      writeFileSync(tmp, brief, 'utf-8');
      renameSync(tmp, briefPath);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
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
    const tmp = `${this.seqPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${next}\n`, 'utf-8');
    renameSync(tmp, this.seqPath);
    return next;
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(this.baseDir, { recursive: true });
    const started = Date.now();
    let fd: number | undefined;
    const token = randomUUID();
    while (fd === undefined) {
      try {
        fd = openSync(this.lockPath, 'wx');
        try {
          writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token })}\n`, 'utf-8');
        } catch (error) {
          try { closeSync(fd); } catch { /* best effort */ }
          fd = undefined;
          try { unlinkSync(this.lockPath); } catch { /* best effort */ }
          throw error;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const observed = this.inspectLock();
        const staleReason = observed ? this.staleReason(observed) : undefined;
        if (observed && staleReason && this.takeOverStaleLock(observed, staleReason)) continue;
        if (Date.now() - started >= this.lockTimeoutMs) throw this.lockTimeoutError(observed);
        sleepSync(this.lockPollMs);
      }
    }
    try {
      return fn();
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
      try {
        const current = this.inspectLock();
        if (current?.owner?.token === token) unlinkSync(this.lockPath);
      } catch { /* best effort; an old owner must never remove a replacement owner's lock */ }
    }
  }

  private inspectLock(): RegistryLockObservation | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, 'r');
      const stat = fstatSync(fd);
      const raw = readFileSync(fd, 'utf-8');
      let owner: RegistryLockOwner | undefined;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0) {
          owner = {
            pid: parsed.pid as number,
            acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined,
            token: typeof parsed.token === 'string' ? parsed.token : undefined,
          };
        }
      } catch { /* legacy empty or malformed lock; mtime is its only safe age signal */ }
      return {
        owner,
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

  private staleReason(observed: RegistryLockObservation): string | undefined {
    const now = Date.now();
    if (observed.owner && !this.processExists(observed.owner.pid)) {
      return `recorded owner pid=${observed.owner.pid} no longer exists`;
    }
    const acquiredAtMs = observed.owner?.acquiredAt ? Date.parse(observed.owner.acquiredAt) : Number.NaN;
    if (Number.isFinite(acquiredAtMs)) {
      const ageMs = now - acquiredAtMs;
      if (ageMs >= this.staleLockMs) return `recorded acquisition is ${Math.floor(ageMs)}ms old`;
      return undefined;
    }
    const ageMs = now - observed.mtimeMs;
    return ageMs >= this.staleLockMs ? `lock mtime is ${Math.floor(ageMs)}ms old and owner metadata is incomplete` : undefined;
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private takeOverStaleLock(observed: RegistryLockObservation, reason: string): boolean {
    const current = this.inspectLock();
    if (!current || current.signature !== observed.signature) return false;
    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const owner = observed.owner ? ` left by pid=${observed.owner.pid}` : '';
    try {
      this.warn(`TaskRegistry: took over stale lock${owner} at ${this.lockPath} (${reason}).`);
    } catch { /* diagnostics must not turn a successful recovery into another outage */ }
    return true;
  }

  private lockTimeoutError(observed: RegistryLockObservation | undefined): Error {
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
