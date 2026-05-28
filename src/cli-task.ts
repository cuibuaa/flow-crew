import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { defaultSocketPath, sendRpc, DaemonUnavailableError } from './orchestrator-rpc.js';
import type { TaskEntry, TaskStatus } from './task-registry.js';

export async function cmdTask(args: string[], opts: { socketPath?: string; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const socketPath = opts.socketPath ?? socketFromArgs(args);
  const sub = args[1];
  try {
    if (sub === 'list') {
      const status = valueAfter(args, '--status') as TaskStatus | 'active' | 'all' | undefined;
      const limitRaw = valueAfter(args, '--limit');
      const res = await sendRpc<{ tasks: TaskEntry[] }>(socketPath, { cmd: 'list', filter: { status: status ?? 'active', limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined } });
      printTaskList(res.tasks, stdout, args.includes('--with-summary'));
      return 0;
    }
    if (sub === 'show') {
      const id = parseId(args[2]);
      const res = await sendRpc<{ task: TaskEntry; recent_ticks: string[] }>(socketPath, { cmd: 'show', id });
      if (args.includes('--summary-only')) {
        if (!res.task.summary_full) {
          stderr.write(`Task #${id} has no parsed summary\n`);
          return 1;
        }
        stdout.write(res.task.summary_full.endsWith('\n') ? res.task.summary_full : `${res.task.summary_full}\n`);
        return 0;
      }
      printTask(res.task, res.recent_ticks, stdout);
      return 0;
    }
    if (sub === 'cancel') {
      const id = parseId(args[2]);
      await sendRpc(socketPath, { cmd: 'cancel', id });
      stdout.write(`Task #${id} cancelled\n`);
      return 0;
    }
    if (sub === 'retry') {
      const id = parseId(args[2]);
      const res = await sendRpc<{ new_attempt: number; unit: string }>(socketPath, { cmd: 'retry', id });
      stdout.write(`Task #${id} retry attempt ${res.new_attempt}. Unit: ${res.unit}\n`);
      return 0;
    }
    if (sub === 'tail') {
      const id = parseId(args[2]);
      const follow = args.includes('--follow') || args.includes('-f');
      const lines = Number.parseInt(valueAfter(args, '--tail') ?? '100', 10);
      if (follow) {
        const show = await sendRpc<{ task: TaskEntry; recent_ticks: string[] }>(socketPath, { cmd: 'show', id });
        const child = spawn('journalctl', ['--user', '-u', show.task.systemd_unit, '-f'], { stdio: 'inherit' });
        await new Promise((resolve) => child.on('exit', resolve));
        return child.exitCode ?? 0;
      }
      const res = await sendRpc<{ output: string }>(socketPath, { cmd: 'tail', id, lines });
      stdout.write(res.output);
      return 0;
    }
    stderr.write('Usage: flowcrew task list|show|cancel|retry|tail ...\n');
    return 1;
  } catch (err) {
    if (err instanceof DaemonUnavailableError) stderr.write(`${err.message}\n`);
    else stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function printTaskList(tasks: TaskEntry[], stdout: NodeJS.WriteStream, withSummary = false): void {
  if (tasks.length === 0) {
    stdout.write('[]\n');
    return;
  }
  stdout.write(withSummary
    ? 'ID  Status        Attempt  Unit                         Name  Summary\n'
    : 'ID  Status        Attempt  Unit                         Name\n');
  for (const task of tasks) {
    const status = task.status === 'reality_gate_failed' ? '✗ reality_gate_failed' : task.status;
    const line = `${String(task.id).padEnd(3)} ${status.padEnd(21)} ${String(task.attempt).padEnd(8)} ${task.systemd_unit.padEnd(28)} ${task.name}`;
    stdout.write(withSummary ? `${line}  ${truncate(task.summary_one_liner ?? '', 80)}\n` : `${line}\n`);
  }
}

function printTask(task: TaskEntry, ticks: string[], stdout: NodeJS.WriteStream): void {
  stdout.write(`Task #${task.id}: ${task.name}\n`);
  if (task.summary_verdict) stdout.write(`Verdict: ${task.summary_verdict}\n`);
  if (task.summary_one_liner) stdout.write(`Summary: ${task.summary_one_liner}\n`);
  stdout.write(`Status: ${task.status}\n`);
  stdout.write(`Attempt: ${task.attempt}/${task.max_retries}\n`);
  stdout.write(`Unit: ${task.systemd_unit}\n`);
  stdout.write(`Project: ${task.projectDir}\n`);
  if (task.brief_path) stdout.write(`Brief: ${task.brief_path}\n`);
  if (task.config_path) stdout.write(`Config: ${task.config_path}\n`);
  if (task.completed_at) stdout.write(`Completed: ${task.completed_at}\n`);
  if (task.notes) stdout.write(`Notes: ${task.notes}\n`);
  const failurePath = task.run_id ? join(homedir(), '.fc', 'runs', task.run_id, '.reality-gate.failures.md') : undefined;
  if (failurePath && existsSync(failurePath)) {
    stdout.write('\nReality gate failures:\n');
    stdout.write(readFileSync(failurePath, 'utf-8').trimEnd() + '\n');
  }
  stdout.write(`Tick log: ${task.tick_log_path}\n`);
  stdout.write('Recent ticks:\n');
  if (ticks.length === 0) stdout.write('  (none)\n');
  else for (const tick of ticks) stdout.write(`  ${tick}\n`);
}

function socketFromArgs(args: string[]): string {
  return valueAfter(args, '--port') ?? valueAfter(args, '--socket') ?? process.env.FLOWCREW_DAEMON_SOCKET ?? defaultSocketPath();
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseId(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Task id must be a positive integer');
  return id;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
