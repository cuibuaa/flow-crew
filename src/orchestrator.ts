import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { TaskRegistry, type TaskCreateInput, type TaskEntry } from './task-registry.js';
import { parseTaskSummary } from './task-summary-parser.js';

const execFileAsync = promisify(execFile);

export interface SystemdAdapter {
  isActive(unit: string): Promise<'active' | 'inactive' | 'failed' | string>;
  runUnit(opts: { unit: string; workingDirectory: string; command: string }): Promise<void>;
  stopUnit(unit: string): Promise<void>;
  journalTail(unit: string, lines: number, follow?: boolean): Promise<string>;
}

export interface GitAdapter {
  findCommitByPrefix(projectDir: string, prefix: string): Promise<string | undefined>;
  hasUncommittedChanges(projectDir: string): Promise<boolean>;
}

export interface OrchestratorOptions {
  registry?: TaskRegistry;
  systemd?: SystemdAdapter;
  git?: GitAdapter;
  intervalMs?: number;
  cliPath?: string;
  now?: () => Date;
}

export class Orchestrator {
  readonly registry: TaskRegistry;
  private readonly systemd: SystemdAdapter;
  private readonly git: GitAdapter;
  private readonly intervalMs: number;
  private readonly cliPath: string;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private startedAt = Date.now();

  constructor(opts: OrchestratorOptions = {}) {
    this.registry = opts.registry ?? new TaskRegistry();
    this.systemd = opts.systemd ?? new NodeSystemd(this.registry.baseDir);
    this.git = opts.git ?? new NodeGit();
    this.intervalMs = opts.intervalMs ?? 30000;
    this.cliPath = opts.cliPath ?? resolve(import.meta.dirname ?? '.', 'cli.js');
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async register(input: TaskCreateInput): Promise<TaskEntry> {
    const task = this.registry.create(input);
    await this.launch(task, task.systemd_unit);
    const now = this.now().toISOString();
    return this.registry.update(task.id, { status: 'running', started_at: now });
  }

  async cancel(id: number): Promise<void> {
    const task = this.mustGet(id);
    await this.systemd.stopUnit(task.systemd_unit);
    const completed = this.now().toISOString();
    this.registry.update(id, { status: 'cancelled', completed_at: completed, notes: 'cancelled by operator' });
    this.registry.appendTick(id, { ts: completed, status: 'cancelled', message: `stopped ${task.systemd_unit}` });
  }

  async retry(id: number): Promise<TaskEntry> {
    const task = this.mustGet(id);
    return this.relaunch(task, 'manual retry');
  }

  async tail(id: number, lines = 100, follow = false): Promise<string> {
    const task = this.mustGet(id);
    return this.systemd.journalTail(task.systemd_unit, lines, follow);
  }

  status(): { uptime: number; watched_tasks: number } {
    const watched = this.registry.list({ status: 'active' }).length;
    return { uptime: Math.floor((Date.now() - this.startedAt) / 1000), watched_tasks: watched };
  }

  async tickOnce(): Promise<void> {
    const tasks = this.registry.list({ status: 'active' });
    for (const task of tasks) {
      await this.tickTask(task);
    }
  }

  private async tickTask(task: TaskEntry): Promise<void> {
    const state = await this.systemd.isActive(task.systemd_unit);
    if (state === 'active') {
      const patch: Partial<TaskEntry> = { status: 'running' };
      if (!task.started_at) patch.started_at = this.now().toISOString();
      this.registry.update(task.id, patch);
      this.registry.appendTick(task.id, { status: 'active', stages: this.readStages(task) });
      return;
    }

    if (state === 'inactive') {
      await this.handleInactive(task);
      return;
    }

    if (state === 'failed') {
      await this.retryOrStuck(task, 'unit failed');
      return;
    }

    this.registry.appendTick(task.id, { status: state, message: `systemd reported ${state}` });
  }

  private async handleInactive(task: TaskEntry): Promise<void> {
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
          });
          this.registry.appendTick(task.id, { ts: completed, status: 'done', message: `commit ${commit}; summary ${summary.path}` });
        } else {
          this.registry.update(task.id, { status: 'stuck', completed_at: completed, completing_commit: commit, notes: `missing artifacts: ${missing.join(', ')}` });
          this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: `missing artifacts: ${missing.join(', ')}` });
        }
        return;
      }
    }

    if (await this.git.hasUncommittedChanges(task.projectDir)) {
      this.registry.update(task.id, { status: 'stuck', completed_at: completed, notes: 'unit exited cleanly with uncommitted changes; operator review needed' });
      this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: 'uncommitted changes need operator review' });
      return;
    }

    await this.retryOrStuck(task, 'unit exited without commit or changes');
  }

  private readCompletionSummary(task: TaskEntry, completed: string, commit: string): { path: string; parsed: ReturnType<typeof parseTaskSummary> } | undefined {
    const summaryPaths = this.summaryPaths(task);
    const summaryPath = summaryPaths.find((p) => existsSync(p) && statSync(p).isFile());
    if (!summaryPath) {
      const message = `task_summary.md not found in expected locations: ${summaryPaths.join(', ')}`;
      this.registry.update(task.id, { status: 'needs_summary', completed_at: completed, completing_commit: commit, notes: message });
      this.registry.appendTick(task.id, { ts: completed, status: 'needs_summary', message });
      return undefined;
    }

    const parsed = parseTaskSummary(readFileSync(summaryPath, 'utf-8'));
    if (!parsed.valid) {
      const message = `task_summary.md malformed: ${parsed.errors.join('; ')}`;
      this.registry.update(task.id, { status: 'needs_summary', completed_at: completed, completing_commit: commit, notes: message });
      this.registry.appendTick(task.id, { ts: completed, status: 'needs_summary', message });
      return undefined;
    }

    return { path: summaryPath, parsed };
  }

  private summaryPaths(task: TaskEntry): string[] {
    const paths: string[] = [];
    if (task.run_id) paths.push(join(resolve(task.run_id), 'task_summary.md'));
    if (task.expected_summary_path) {
      const expectedPath = resolve(task.projectDir, task.expected_summary_path);
      paths.push(expectedPath);
      if (!expectedPath.endsWith('task_summary.md')) paths.push(join(expectedPath, 'task_summary.md'));
    }
    paths.push(join(task.projectDir, 'docs', 'task_summary.md'));
    return Array.from(new Set(paths));
  }

  private async retryOrStuck(task: TaskEntry, reason: string): Promise<void> {
    if (task.attempt < task.max_retries) {
      await this.relaunch(task, reason);
      return;
    }
    const completed = this.now().toISOString();
    this.registry.update(task.id, { status: 'stuck', completed_at: completed, notes: reason });
    this.registry.appendTick(task.id, { ts: completed, status: 'stuck', message: reason });
  }

  private async relaunch(task: TaskEntry, reason: string): Promise<TaskEntry> {
    const attempt = task.attempt + 1;
    const unit = `flowcrew-task-${task.id}-attempt-${attempt}.service`;
    const updated = this.registry.update(task.id, { attempt, systemd_unit: unit, status: 'running', started_at: this.now().toISOString(), notes: reason });
    await this.launch(updated, unit);
    this.registry.appendTick(task.id, { status: 'retry', message: `${reason}; launched ${unit}` });
    return updated;
  }

  private async launch(task: TaskEntry, unit: string): Promise<void> {
    await this.systemd.runUnit({
      unit,
      workingDirectory: task.projectDir,
      command: this.buildCommand(task),
    });
  }

  private buildCommand(task: TaskEntry): string {
    const userArgs = task.launch_args ?? [];
    const userHasCampaign = userArgs.includes('--campaign') || userArgs.includes('--no-campaign');
    const args = task.kind === 'campaign'
      ? ['campaign', 'run', task.config_path ?? '', ...userArgs]
      : ['quick', '--task', task.brief_text ?? readBrief(task), '--project', task.projectDir,
         ...(userHasCampaign ? [] : ['--no-campaign']),
         '--supervise', ...userArgs];
    return shellJoin(['node', this.cliPath, ...args.filter(Boolean)]);
  }

  private readStages(task: TaskEntry): unknown {
    if (!task.run_id) return undefined;
    try {
      const runPath = resolve(task.run_id);
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
}

export class NodeSystemd implements SystemdAdapter {
  private fallbackDir: string;

  constructor(baseDir: string) {
    this.fallbackDir = join(baseDir, 'systemd-fallback');
    mkdirSync(this.fallbackDir, { recursive: true });
  }

  async isActive(unit: string): Promise<'active' | 'inactive' | 'failed' | string> {
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', unit]);
      return stdout.trim() || 'inactive';
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout?.trim();
      if (stdout === 'failed' || stdout === 'inactive') return stdout;
      return this.fallbackState(unit);
    }
  }

  async runUnit(opts: { unit: string; workingDirectory: string; command: string }): Promise<void> {
    try {
      await execFileAsync('systemd-run', ['--user', `--unit=${opts.unit}`, `--working-directory=${opts.workingDirectory}`, 'bash', '-lc', opts.command]);
    } catch {
      mkdirSync(this.fallbackDir, { recursive: true });
      const child = spawn('bash', ['-lc', opts.command], {
        cwd: opts.workingDirectory,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      writeFileSync(this.fallbackPath(opts.unit), JSON.stringify({ pid: child.pid, state: 'active', command: opts.command }), 'utf-8');
    }
  }

  async stopUnit(unit: string): Promise<void> {
    try { await execFileAsync('systemctl', ['--user', 'stop', unit]); } catch { /* fallback below */ }
    const path = this.fallbackPath(unit);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: number };
      if (parsed.pid) process.kill(parsed.pid, 'SIGTERM');
    } catch { /* best effort */ }
    writeFileSync(path, JSON.stringify({ state: 'inactive' }), 'utf-8');
  }

  async journalTail(unit: string, lines: number, follow = false): Promise<string> {
    if (follow) return `Follow mode is available via journalctl --user -u ${unit} -f`;
    try {
      const { stdout } = await execFileAsync('journalctl', ['--user', '-u', unit, '-n', String(lines), '--no-pager']);
      return stdout;
    } catch {
      return '';
    }
  }

  private fallbackState(unit: string): 'active' | 'inactive' | 'failed' {
    const path = this.fallbackPath(unit);
    if (!existsSync(path)) return 'inactive';
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: number; state?: string };
      if (parsed.state === 'inactive' || parsed.state === 'failed') return parsed.state;
      if (!parsed.pid) return 'inactive';
      try {
        process.kill(parsed.pid, 0);
        return 'active';
      } catch {
        rmSync(path, { force: true });
        return 'inactive';
      }
    } catch {
      return 'failed';
    }
  }

  private fallbackPath(unit: string): string {
    return join(this.fallbackDir, `${unit.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }
}

function readBrief(task: TaskEntry): string {
  if (task.brief_text) return task.brief_text;
  if (task.brief_path) return readFileSync(task.brief_path, 'utf-8');
  return task.name;
}

function shellJoin(parts: string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
}
