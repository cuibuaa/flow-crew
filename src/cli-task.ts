import { EXIT_CODE } from './exit-code.js';
import { parseCommandArgs, commandUsage } from './cli-args.js';
import { closeSync, openSync } from './engine-fs.js';
import { existsSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  commandSocketPath,
  rpcErrorExitCode,
  sendRpc,
  type RpcRequest,
  type RpcResponse,
  type TaskListRpcResponse,
  type TaskShowRpcResponse,
  type TaskShowEntry,
  type TaskTailRpcResponse,
} from './orchestrator-rpc.js';
import {
  cancelTaskThroughControlPlane,
  type CancellationClientOptions,
} from './cancellation-client.js';
import {
  TASK_LIST_STATUS,
  TASK_STATUS,
  isActiveTaskStatus,
  type TaskListStatus,
} from './task-registry.js';
import type { SupervisorLogSource, UnitStatus } from './supervision.js';
import { runsRoot } from './store.js';
import { findExecutableOnPath } from './adapters/availability.js';
import { formatHumanDuration, formatOperationalReason } from './cli-events.js';
import { formatRunDriftProjection } from './run-drift.js';
import { isTerminalRunStatus, taskDisplayStatus as projectTaskDisplayStatus } from './lifecycle-status.js';

export interface TaskFollowControls {
  findCommand: (command: string) => string | undefined;
  spawnProcess: typeof spawn;
  followFile: (
    path: string,
    stdout: NodeJS.WriteStream,
    stderr: NodeJS.WriteStream,
    offset: number,
  ) => Promise<number>;
}

export async function cmdTask(
  args: string[],
  opts: {
    socketPath?: string;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
    rpcTimeoutMs?: number;
    cancellationClient?: Omit<CancellationClientOptions, 'socketPath' | 'rpcTimeoutMs'>;
    followControls?: Partial<TaskFollowControls>;
  } = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const sub = args[1]?.startsWith('-') ? undefined : args[1];
  try {
    const parsed = parseCommandArgs(`task${sub ? ` ${sub}` : ''}`, args);
    if (parsed.help) {
      stdout.write(`${taskUsage(sub)}\n`);
      return 0;
    }
    const socketPath = commandSocketPath(opts.socketPath ?? parsed.values.get('--socket'));
    const rpc = <T extends RpcResponse = RpcResponse>(request: RpcRequest) => (
      sendRpc<T>(socketPath, request, opts.rpcTimeoutMs)
    );
    if (sub === 'list') {
      const status = parsed.values.get('--status') as TaskListStatus | undefined;
      const limitRaw = parsed.values.get('--limit');
      const res = await rpc<TaskListRpcResponse>({ cmd: 'list', filter: { status: status ?? TASK_LIST_STATUS.ACTIVE, limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined } });
      printTaskList(res.tasks, stdout, parsed.flags.has('--with-summary'));
      if ((res.registry_unreadable_records ?? 0) > 0) {
        stderr.write(`WARNING: registry has ${res.registry_unreadable_records} unreadable records; displayed task state may be incomplete.\n`);
      }
      return 0;
    }
    if (sub === 'show') {
      const id = parseId(parsed.positionals[0]);
      const includeRaw = parsed.flags.has('--raw');
      const res = await rpc<TaskShowRpcResponse>({ cmd: 'show', id, raw: includeRaw });
      if (parsed.flags.has('--summary-only')) {
        if (!res.task.summary_full) {
          stderr.write(`Task #${id} has no parsed summary\n`);
          return 1;
        }
        stdout.write(res.task.summary_full.endsWith('\n') ? res.task.summary_full : `${res.task.summary_full}\n`);
        return 0;
      }
      printTask(res.task, res.recent_ticks, stdout, res.unit_status, res.exit_code, includeRaw);
      return 0;
    }
    if (sub === 'cancel') {
      const id = parseId(parsed.positionals[0]);
      const cancellation = await cancelTaskThroughControlPlane(id, {
        ...opts.cancellationClient,
        socketPath,
        rpcTimeoutMs: opts.rpcTimeoutMs,
      });
      if (!cancellation.ok) {
        if (cancellation.status === 'outcome-unknown') {
          stderr.write(`Cancellation outcome unknown; processes may still be running: ${cancellation.message}\n`);
        } else {
          stderr.write(`Cancellation still in progress: ${cancellation.message}. Check progress with: flowcrew task show ${id}\n`);
        }
        return cancellation.status === 'outcome-unknown' ? EXIT_CODE.outcomeUnknown : EXIT_CODE.failed;
      }
      stdout.write(`Task #${id} cancelled\n`);
      return 0;
    }
    if (sub === 'retry' || sub === 'resume') {
      const id = parseId(parsed.positionals[0]);
      const res = await rpc<{ new_attempt: number; unit: string }>({ cmd: sub, id });
      stdout.write(`Task #${id} ${sub} queued (budget attempt ${res.new_attempt}). Current unit: ${res.unit}\n`);
      return 0;
    }
    if (sub === 'tail') {
      const id = parseId(parsed.positionals[0]);
      const follow = parsed.flags.has('--follow') || parsed.flags.has('-f');
      const lines = Number.parseInt(parsed.values.get('--tail') ?? '100', 10);
      if (follow) {
        const res = await rpc<TaskTailRpcResponse>({ cmd: 'tail', id, lines, follow: true });
        stdout.write(res.output);
        if (!res.source) {
          stderr.write('The daemon did not provide a follow source; restart it and retry.\n');
          return 1;
        }
        return followTaskLog(res.source, stdout, stderr, opts.followControls);
      }
      const res = await rpc<TaskTailRpcResponse>({ cmd: 'tail', id, lines });
      stdout.write(res.output);
      return 0;
    }
    stderr.write(`${taskUsage()}\n`);
    return 1;
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return rpcErrorExitCode(err);
  }
}

export function taskUsage(subcommand?: string): string {
  return commandUsage(`task${subcommand ? ` ${subcommand}` : ''}`);
}

function taskDisplayStatus(task: TaskShowEntry): string {
  // A terminal bound run supersedes a stale running registry entry in CLI output.
  const status = task.status === TASK_STATUS.RUNNING && task.run && isTerminalRunStatus(task.run.status)
    ? task.run.status
    : task.status;
  return projectTaskDisplayStatus(status, task.run?.status);
}

function printTaskList(tasks: TaskShowEntry[], stdout: NodeJS.WriteStream, withSummary = false): void {
  if (tasks.length === 0) {
    stdout.write('[]\n');
    return;
  }
  stdout.write(withSummary
    ? 'ID  Status  Launch  Run  Current stage  Elapsed  Unit  Name  Latest reason  Summary\n'
    : 'ID  Status  Launch  Run  Current stage  Elapsed  Unit  Name  Latest reason\n');
  for (const task of tasks) {
    const displayStatus = taskDisplayStatus(task);
    const lifecycle = displayStatus === TASK_STATUS.REALITY_GATE_FAILED ? '✗ reality_gate_failed' : displayStatus;
    const status = task.terminal_status_mismatch
      ? `${lifecycle} [terminal artifact says ${task.terminal_status_mismatch.terminal_status}]`
      : lifecycle;
    const active = task.operational?.activeStages[0];
    const currentStage = active
      ? `${active.id} (attempt ${active.execution})`
      : '—';
    const elapsed = formatHumanDuration(active?.elapsedMs ?? task.operational?.runElapsedMs);
    const operationalReason = task.operational?.lastRejection ?? task.operational?.latestReason;
    const reason = operationalReason
      ? formatOperationalReason(operationalReason)
      : task.defer_reason ?? task.run?.failureReason ?? '—';
    const fields = [
      String(task.id),
      truncate(status, 44),
      String(task.launch),
      task.run_id ?? '—',
      truncate(currentStage, 42),
      elapsed,
      task.systemd_unit,
      task.name,
      truncate(reason, 160),
    ];
    if (withSummary) fields.push(truncate(task.summary_one_liner ?? '', 80));
    stdout.write(`${fields.join('  ')}\n`);
  }
}

function printTask(
  task: TaskShowEntry,
  ticks: string[],
  stdout: NodeJS.WriteStream,
  unitStatus?: UnitStatus,
  exitCode?: number,
  includeRaw = false,
): void {
  stdout.write(`Task #${task.id}: ${task.name}\n`);
  const verdict = task.run_verdict;
  if (verdict) stdout.write(`Verdict: ${verdict}\n`);
  if (task.summary_one_liner) stdout.write(`Summary: ${task.summary_one_liner}\n`);
  const displayStatus = taskDisplayStatus(task);
  const projectedStatus = isActiveTaskStatus(displayStatus) && unitStatus?.kind === 'terminal' && !task.scheduler_live
    ? 'terminal'
    : isActiveTaskStatus(displayStatus) && unitStatus?.kind === 'terminal-unknown' && !task.scheduler_live
      ? 'terminal-unknown'
      : displayStatus;
  stdout.write(`Status: ${projectedStatus}\n`);
  if (task.terminal_status_mismatch) {
    stdout.write(`Status mismatch: lifecycle status ${task.terminal_status_mismatch.lifecycle_status}; `
      + `terminal artifact ${JSON.stringify(task.terminal_status_mismatch.terminal_artifact)} `
      + `declares ${task.terminal_status_mismatch.terminal_status}\n`);
  }
  if (Number.isSafeInteger(exitCode)) stdout.write(`Exit code: ${exitCode}\n`);
  if (unitStatus?.kind === 'terminal' && unitStatus.signal) stdout.write(`Signal: ${unitStatus.signal}\n`);
  stdout.write(`Launch: ${task.launch}; budget used: ${task.attempt}/${task.max_attempts}\n`);
  stdout.write(`Run: ${task.run_id ?? 'not started'}\n`);
  for (const entry of task.engine_history ?? []) stdout.write(`Engine ${entry.kind}: ${entry.generation ?? 'UNVERIFIED'} at ${entry.at} (scheduler pid=${entry.pid})\n`);
  if (task.continuation_failure) stdout.write(`Continuation refused: ${task.continuation_failure.reason}\n`);
  const operational = task.operational;
  if (operational) {
    stdout.write(`Run elapsed: ${formatHumanDuration(operational.runElapsedMs)}\n`);
    if (operational.activeStages.length === 0) stdout.write('Current stage: none executing\n');
    else for (const stage of operational.activeStages) {
      stdout.write(`Current stage: ${stage.id} · execution ${stage.execution} · ${formatHumanDuration(stage.elapsedMs)}\n`);
    }
    if (operational.latestReason) stdout.write(`Latest reason ${formatOperationalReason(operational.latestReason)}\n`);
    if (operational.lastRejection) stdout.write(`Latest rejection ${formatOperationalReason(operational.lastRejection)}\n`);
    if (operational.lastGuidance) stdout.write(`Latest guidance ${formatOperationalReason(operational.lastGuidance)}\n`);
    for (const pending of operational.pendingScope) {
      stdout.write(`Pending scope request: ${pending.requestId}${pending.stageId ? ` · ${pending.stageId}` : ''}${pending.detail ? ` · ${pending.detail}` : ''}\n`);
    }
    if (operational.pendingApproval) stdout.write(`Pending approval: ${operational.pendingApproval.detail}\n`);
    for (const line of formatRunDriftProjection(operational.drift)) stdout.write(`${line}\n`);
    stdout.write(`Evidence: state ${operational.sourceCoverage.runState}; events ${operational.sourceCoverage.events}; ${operational.sourceCoverage.stageCount} stages\n`);
  }
  stdout.write(`Unit: ${task.systemd_unit}\n`);
  stdout.write(`Project: ${task.projectDir}\n`);
  if (task.brief_path) stdout.write(`Brief: ${task.brief_path}\n`);
  if (task.config_path) stdout.write(`Config: ${task.config_path}\n`);
  const completedAt = task.run?.completedAt ?? task.completed_at;
  if (completedAt) stdout.write(`Completed: ${completedAt}\n`);
  if (task.run?.failureReason) stdout.write(`Failure reason: ${task.run.failureReason}\n`);
  if (task.notes) stdout.write(`Notes: ${task.notes}\n`);
  const failurePath = task.run_id ? join(runsRoot(), task.run_id, '.reality-gate.failures.md') : undefined;
  if (failurePath && existsSync(failurePath)) {
    stdout.write('\nReality gate failures:\n');
    stdout.write(readFileSync(failurePath, 'utf-8').trimEnd() + '\n');
  }
  if (includeRaw) {
    stdout.write(`Tick log: ${task.tick_log_path}\n`);
    stdout.write('Recent ticks (raw JSON):\n');
    if (ticks.length === 0) stdout.write('  (none)\n');
    else for (const tick of ticks) stdout.write(`  ${tick}\n`);
  } else {
    stdout.write('Raw ticks: hidden (pass --raw)\n');
  }
}

function parseId(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Task id must be a positive integer');
  return id;
}

function truncate(value: string, max: number): string {
  const compact = value.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : compact.slice(0, max);
}

async function followTaskLog(
  source: SupervisorLogSource,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  overrides: Partial<TaskFollowControls> = {},
): Promise<number> {
  const controls: TaskFollowControls = {
    findCommand: findExecutableOnPath,
    spawnProcess: spawn,
    followFile: followPortableLog,
    ...overrides,
  };
  switch (source.kind) {
    case 'file': {
      const offset = source.offset !== undefined
        && Number.isSafeInteger(source.offset)
        && source.offset >= 0
        ? source.offset
        : 0;
      return controls.followFile(source.path, stdout, stderr, offset);
    }
    case 'journal': {
      const journalctl = controls.findCommand('journalctl');
      if (!journalctl) {
        stderr.write(`Follow mode is unavailable: journalctl is not installed and no portable log exists for ${source.unit}.\n`);
        return 1;
      }
      try {
        const child = controls.spawnProcess(
          journalctl,
          ['--user', '-u', source.unit, '-n', '0', '-f'],
          { stdio: 'inherit' },
        );
        return await new Promise<number>((resolve) => {
          let settled = false;
          const finish = (code: number) => {
            if (settled) return;
            settled = true;
            resolve(code);
          };
          child.once('error', (error) => {
            stderr.write(`Could not follow journal for ${source.unit}: ${error.message}\n`);
            finish(1);
          });
          child.once('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
        });
      } catch (error) {
        stderr.write(`Could not follow journal for ${source.unit}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case 'unavailable':
      stderr.write(`Follow mode is unavailable: ${source.reason}\n`);
      return 1;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

async function followPortableLog(
  path: string,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  initialOffset: number,
): Promise<number> {
  let offset = initialOffset;

  return new Promise<number>((resolve) => {
    let settled = false;
    let pumping = false;
    let pending = false;
    const onSignal = () => finish(0);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(code);
    };
    const pump = () => {
      if (pumping) {
        pending = true;
        return;
      }
      pumping = true;
      do {
        pending = false;
        try {
          const size = statSync(path).size;
          if (size < offset) offset = 0;
          if (size > offset) {
            const fd = openSync(path, 'r');
            try {
              const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
              while (offset < size) {
                const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
                if (bytesRead <= 0) break;
                stdout.write(buffer.subarray(0, bytesRead));
                offset += bytesRead;
              }
            } finally {
              closeSync(fd);
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            stderr.write(`Could not follow portable task log ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
            finish(1);
          }
        }
      } while (pending && !settled);
      pumping = false;
    };
    // Poll unconditionally rather than reacting to fs.watchFile change events.
    //
    // watchFile takes its baseline stat asynchronously when it is registered.
    // If a write lands between the initial pump below and that baseline being
    // taken, the baseline already contains the write, so there is no later
    // change to report — and because nothing else writes to the file, the
    // listener never fires again and the appended content is lost for good.
    // That is not a slow delivery, it is a permanent miss, and it is exactly
    // the blind interval this function exists to close.
    //
    // Measured on the same machine, appending immediately after arming the
    // follower: idle, watchFile delivered 40/40 (p50 252ms). Under five busy
    // cores it delivered 6/40 — a 85% permanent-miss rate — while the runs that
    // did arrive still arrived in ~300ms, the bimodal signature of a lost event
    // rather than a slow one. Polling the size directly: 40/40 under the same
    // load, p50 275ms. Same latency, no misses.
    //
    // pump() already compares size against offset, so it is stateless and
    // idempotent; nothing is gained by being told when to run it.
    const poll = setInterval(pump, 250);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    queueMicrotask(pump);
  });
}
