import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type TaskStatus = 'pending' | 'running' | 'done' | 'stuck' | 'needs_summary' | 'cancelled' | 'failed' | 'reality_gate_failed';
export type TaskKind = 'quick' | 'campaign';
export type TaskSummaryVerdict = 'PASS' | 'FAIL' | 'ESCALATE';

export interface TaskEntry {
  id: number;
  name: string;
  kind?: TaskKind;
  brief_path?: string;
  brief_text?: string;
  config_path?: string;
  projectDir: string;
  systemd_unit: string;
  run_id?: string;
  status: TaskStatus;
  attempt: number;
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
}

export interface TaskCreateInput {
  name?: string;
  kind?: TaskKind;
  brief_path?: string;
  brief_text?: string;
  config_path?: string;
  projectDir: string;
  systemd_unit?: string;
  run_id?: string;
  status?: TaskStatus;
  attempt?: number;
  max_retries?: number;
  commit_prefix?: string;
  expected_artifacts?: string[];
  expected_summary_path?: string;
  notes?: string;
  launch_args?: string[];
}

export interface TaskListFilter {
  status?: TaskStatus | 'active' | 'all';
  limit?: number;
}

export interface TaskTick {
  ts?: string;
  status: string;
  message?: string;
  stages?: unknown;
}

export function defaultFcDir(): string {
  return join(homedir(), '.fc');
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
  private readonly now: () => Date;

  constructor(opts: { baseDir?: string; now?: () => Date } = {}) {
    this.baseDir = opts.baseDir ?? defaultFcDir();
    this.registryPath = join(this.baseDir, 'tasks.jsonl');
    this.seqPath = join(this.baseDir, 'tasks-seq');
    this.tasksDir = join(this.baseDir, 'tasks');
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.tasksDir, { recursive: true });
  }

  create(input: TaskCreateInput): TaskEntry {
    return this.withLock(() => {
      const id = this.nextIdUnlocked();
      const taskDir = join(this.tasksDir, String(id));
      mkdirSync(taskDir, { recursive: true });
      const brief = input.brief_text ?? input.brief_path ?? input.config_path ?? '';
      const name = input.name ?? (brief.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').slice(0, 80) || `Task ${id}`);
      const entry: TaskEntry = {
        id,
        name,
        kind: input.kind ?? (input.config_path ? 'campaign' : 'quick'),
        brief_path: input.brief_path,
        brief_text: input.brief_text,
        config_path: input.config_path,
        projectDir: input.projectDir,
        systemd_unit: input.systemd_unit ?? `flowcrew-task-${id}.service`,
        run_id: input.run_id,
        status: input.status ?? 'pending',
        attempt: input.attempt ?? 1,
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
    let tasks = Array.from(this.readLatest().values()).sort((a, b) => a.id - b.id);
    if (filter.status && filter.status !== 'all') {
      if (filter.status === 'active') tasks = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
      else tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter.limit && filter.limit > 0) tasks = tasks.slice(-filter.limit);
    return tasks;
  }

  get(id: number): TaskEntry | undefined {
    return this.readLatest().get(id);
  }

  update(id: number, patch: Partial<Omit<TaskEntry, 'id' | 'created_at' | 'tick_log_path'>>): TaskEntry {
    return this.withLock(() => {
      const current = this.readLatest().get(id);
      if (!current) throw new Error(`Task not found: ${id}`);
      const next = { ...current, ...patch, id: current.id, created_at: current.created_at, tick_log_path: current.tick_log_path };
      this.appendEntry(next);
      return next;
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

  private readLatest(): Map<number, TaskEntry> {
    const tasks = new Map<number, TaskEntry>();
    if (!existsSync(this.registryPath)) return tasks;
    const lines = readFileSync(this.registryPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TaskEntry;
        if (typeof parsed.id === 'number') tasks.set(parsed.id, parsed);
      } catch {
        continue;
      }
    }
    return tasks;
  }

  private appendEntry(entry: TaskEntry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    appendFileSync(this.registryPath, `${JSON.stringify(entry)}\n`, 'utf-8');
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
    const lockPath = join(this.baseDir, 'tasks.lock');
    const started = Date.now();
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() - started > 5000) throw err;
        sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
      try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
