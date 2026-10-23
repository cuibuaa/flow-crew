import './test-support/policy-runtime.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendRpc, type RpcResponse } from '../src/orchestrator-rpc.js';
import type { CancellationResult } from '../src/run-control.js';
import { TERMINAL_STATUSES } from '../src/store.js';
import { TASK_STATUS, TaskRegistry, type TaskEntry } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const repositoryRoot = join(import.meta.dirname, '..');
const distCli = join(repositoryRoot, 'dist', 'cli.js');
const MOCK_OUTPUT_SENTINEL = 'FLOWCREW_MOCK_AGENT_STDOUT_SENTINEL_7d94a6';
const HOLD_MARKER = 'FLOWCREW_SUPERVISED_HOLD_2f6c1b';
const EXIT_THREE_MARKER = 'FLOWCREW_SUPERVISED_EXIT_3_61c8f0';
const LIFECYCLE_CRITERION = '1. Record the supervised lifecycle outcome for this fixture.';
interface Harness {
  root: string;
  home: string;
  fcHome: string;
  bin: string;
  socketPath: string;
  mockDir: string;
  preloadPath: string;
  defaultProject: string;
  daemon: ChildProcess;
  daemonOutput: string;
  ownedShimPids: Set<number>;
  ownedAgentPids: Set<number>;
}

interface RegisteredTask {
  id: number;
  unit: string;
  project: string;
}

interface RunSnapshot {
  task: TaskEntry;
  runId: string;
  runPath: string;
  state: { status: string; completedAt?: string };
}

let activeHarness: Harness | undefined;

afterEach(async () => {
  if (!activeHarness) return;
  const harness = activeHarness;
  activeHarness = undefined;
  await cleanupHarness(harness);
});

describe('portable supervised lifecycle through the real CLI', () => {
  it('[1] launches, cancels and restarts a task without legacy mirror files', { timeout: 60_000 }, async ({ signal }) => {
    const harness = await createHarness();
    const task = registerBackgroundTask(harness, createProject(harness, 'cancel-cli'), HOLD_MARKER);
    const pid = await waitForRecordedAgentPid(harness, task.unit);
    await waitForHeldAgent(harness, pid, signal);

    const cancelled = runCliSync(harness, task.project, ['task', 'cancel', String(task.id)]);
    const output = `${cancelled.stdout}${cancelled.stderr}`;
    const controlDir = join(harness.fcHome, 'supervise', safeUnit(task.unit));
    const runningPath = join(controlDir, 'running.json');
    const exitPath = join(controlDir, 'exit.json');
    let shimState = 'unreadable';
    try {
      const running = JSON.parse(readFileSync(runningPath, 'utf-8')) as { shimPid?: number };
      if (running.shimPid) shimState = `${running.shimPid}:${pidProbe(running.shimPid)}`;
    } catch { /* failure message remains useful when the record is absent */ }

    expect(
      { status: cancelled.status, output },
      `cancel did not converge for recorded pid ${pid} (${pidProbe(pid)}), shim ${shimState}, exit=${existsSync(exitPath)}: ${output}; daemon=${harness.daemonOutput.slice(-500)}`,
    ).toMatchObject({ status: 0, output: expect.stringContaining(`Task #${task.id} cancelled`) });
    expect(pidProbe(pid), `cancel returned before agent ${pid} exited`).toBe('esrch');

    const retried = runCliSync(harness, task.project, ['task', 'resume', String(task.id)]);
    expect(retried.status, `${retried.stdout}${retried.stderr}`).toBe(0);
    let restarted: TaskEntry | undefined;
    expect(await waitUntil(async () => {
      restarted = await showTask(harness, task.id);
      return restarted.systemd_unit !== task.unit && restarted.status === TASK_STATUS.RUNNING;
    }, 35_000)).toBe(true); // The daemon drains its queue every 30 s.
    const restartedPid = await waitForRecordedAgentPid(harness, restarted!.systemd_unit);
    await waitForHeldAgent(harness, restartedPid, signal);
    expect(restartedPid).not.toBe(pid);
    const stopped = runCliSync(harness, task.project, ['task', 'cancel', String(task.id)]);
    expect(stopped.status, `${stopped.stdout}${stopped.stderr}`).toBe(0);
    expect(pidProbe(restartedPid)).toBe('esrch');
    for (const unit of [task.unit, restarted!.systemd_unit]) {
      const directory = join(harness.fcHome, 'supervise', safeUnit(unit));
      expect(readdirSync(directory)).toEqual(expect.arrayContaining(['launch.json', 'running.json', 'exit.json']));
    }
    const mirrorDir = join(harness.fcHome, 'systemd-fallback');
    expect(existsSync(mirrorDir) ? readdirSync(mirrorDir) : []).toEqual([]);
  });

  it('[3] shows a natural exit code 3 and a terminal status', async () => {
    const harness = await createHarness();
    const task = registerBackgroundTask(harness, createProject(harness, 'exit-three'), EXIT_THREE_MARKER);
    const pid = await waitForRecordedAgentPid(harness, task.unit);
    await waitUntil(() => pidProbe(pid) === 'esrch' || exitRecordExists(harness, task.unit), 5_000);

    const shown = await waitForCliResult(
      () => runCliSync(harness, task.project, ['task', 'show', String(task.id)]),
      (result) => result.stdout.includes('Exit code: 3'),
      5_000,
    );
    const output = `${shown.stdout}${shown.stderr}`;

    expect(output).toContain('Exit code: 3');
    expect(output).toMatch(/Status: (?:done|failed|stuck|cancelled|complete|terminal(?:-unknown)?)/);
  });

  it('[4] returns already-terminal without clearing completed_at', { timeout: 60_000 }, async () => {
    const harness = await createHarness();
    const registry = new TaskRegistry({ baseDir: harness.fcHome });
    const task = registry.create({ projectDir: harness.defaultProject, status: TASK_STATUS.DONE });
    const completedAt = '2026-08-06T22:00:00.000Z';
    registry.update(task.id, { completed_at: completedAt });

    let response: CancellationResult | undefined;
    let error: string | undefined;
    try {
      response = await sendRpc<CancellationResult>(harness.socketPath, { cmd: 'cancel', id: task.id });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const after = await showTask(harness, task.id);

    expect(
      { responseStatus: response?.status, error, completedAt: after.completed_at },
      `terminal cancellation was not preserved: ${error ?? JSON.stringify(response)}`,
    ).toEqual({ responseStatus: 'already-terminal', error: undefined, completedAt });
  });

  it('[6] merges terminal run.json state over a stale running registry status and preserves portable tail output', { timeout: 60_000 }, async () => {
    const harness = await createHarness();
    const task = registerBackgroundTask(harness, createProject(harness, 'show-terminal'), 'show fixture');
    const terminal = await waitForTerminalRun(harness, task.id);
    const registry = new TaskRegistry({ baseDir: harness.fcHome });
    registry.update(task.id, { status: TASK_STATUS.RUNNING });
    if (registry.get(task.id)?.status !== TASK_STATUS.RUNNING) {
      throw new Error(`failed to establish stale running registry fixture for task #${task.id}`);
    }

    const shown = runCliSync(harness, task.project, ['task', 'show', String(task.id)]);
    const output = `${shown.stdout}${shown.stderr}`;

    expect(shown.status, output).toBe(0);
    expect(output).toContain(`Status: ${terminal.state.status}`);
    expect(output).not.toContain('Status: running');
    const tailed = runCliSync(harness, task.project, ['task', 'tail', String(task.id)]);
    expect(tailed.status, tailed.stderr).toBe(0);
    expect(tailed.stdout).toContain(MOCK_OUTPUT_SENTINEL);
  });
});

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'fc-sl-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const mockDir = join(root, 'mock');
  const defaultProject = join(root, 'project');
  const socketPath = join(root, 'daemon.sock');
  const preloadPath = join(root, 'portable-fixture.cjs');
  for (const directory of [home, bin, mockDir, defaultProject]) {
    mkdirSync(directory, { recursive: true });
  }
  expect(socketPath.length, `Darwin Unix socket path is ${socketPath.length} bytes: ${socketPath}`).toBeLessThan(104);

  linkFirstAvailable(bin, 'bash', ['/bin/bash', '/usr/bin/bash']);
  linkFirstAvailable(bin, 'sh', ['/bin/sh', '/usr/bin/sh']);
  linkFirstAvailable(bin, 'git', ['/usr/bin/git', '/bin/git']);
  linkFirstAvailable(bin, 'ps', ['/bin/ps', '/usr/bin/ps']);
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const forbidden of ['systemctl', 'systemd-run', 'journalctl']) {
    expect(existsSync(join(bin, forbidden))).toBe(false);
  }
  writeFileSync(join(home, '.bash_profile'), `export PATH=${shellQuote(bin)}\n`, 'utf-8');
  writeFileSync(join(mockDir, 'implement.json'), JSON.stringify({
    output_text: MOCK_OUTPUT_SENTINEL,
    exit_code: 0,
    tokens_in: 0,
    tokens_out: 0,
  }), 'utf-8');
  writeFileSync(join(mockDir, 'review.json'), JSON.stringify({
    output_text: 'portable fixture gate passed', exit_code: 0,
    write_files: { 'verdict_review.json': JSON.stringify({ pass: true, reason: 'deterministic lifecycle evidence' }) },
  }), 'utf-8');
  writeFileSync(preloadPath, preloadSource(), 'utf-8');

  let daemonOutput = '';
  const daemon = spawn(
    process.execPath,
    [distCli, 'daemon', 'serve', '--socket', socketPath],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        FC_HOME: root,
        PROJECT_DIR: defaultProject,
        PATH: bin,
        FLOWCREW_DAEMON_SOCKET: socketPath,
        MOCK_FIXTURE_DIR: mockDir,
        NODE_OPTIONS: `--require=${preloadPath}`,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const harness: Harness = {
    root,
    home,
    fcHome: root,
    bin,
    socketPath,
    mockDir,
    preloadPath,
    defaultProject,
    daemon,
    daemonOutput,
    ownedShimPids: new Set(),
    ownedAgentPids: new Set(),
  };
  activeHarness = harness;
  daemon.stdout?.setEncoding('utf-8');
  daemon.stderr?.setEncoding('utf-8');
  daemon.stdout?.on('data', (chunk) => {
    harness.daemonOutput += String(chunk);
  });
  daemon.stderr?.on('data', (chunk) => {
    harness.daemonOutput += String(chunk);
  });
  daemon.once('error', (error) => {
    harness.daemonOutput += `daemon spawn error: ${error.message}\n`;
  });

  const ready = await waitUntil(async () => {
    if (daemon.exitCode !== null) return false;
    if (!existsSync(socketPath)) return false;
    try {
      const response = await sendRpc<RpcResponse>(socketPath, { cmd: 'status' }, 300);
      return typeof response === 'object' && response !== null;
    } catch {
      return false;
    }
  }, 5_000);
  if (!ready) throw new Error(`real daemon did not become ready: ${harness.daemonOutput}`);
  return harness;
}

function createProject(harness: Harness, label: string): string {
  const project = join(harness.root, `p-${label}`);
  mkdirSync(project);
  return project;
}

function registerBackgroundTask(harness: Harness, project: string, marker: string): RegisteredTask {
  const brief = [
    '# Goal',
    `Exercise portable supervision: ${marker}`,
    '',
    '## What the report must show',
    LIFECYCLE_CRITERION,
    '',
  ].join('\n');
  writeReadySetupRecord(project, brief, harness.fcHome);
  const result = runCliSync(harness, project, [
    'quick',
    '--background',
    '--acknowledge-brief-warnings',
    '--project', project,
    '--adapter', 'mock',
    '--workflow', 'direct',
    '--no-campaign',
    '--task', brief,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`background registration failed (exit ${result.status}): ${output}`);
  const match = output.match(/Task #(\d+) registered[\s\S]*?Unit: (\S+)/);
  if (!match) throw new Error(`background registration did not return task identity: ${output}`);
  return { id: Number.parseInt(match[1], 10), unit: match[2], project };
}

function runCliSync(harness: Harness, project: string, cliArgs: string[]) {
  return spawnSync(
    process.execPath,
    [distCli, ...cliArgs],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: harness.home,
        FC_HOME: harness.fcHome,
        PROJECT_DIR: project,
        PATH: harness.bin,
        FLOWCREW_DAEMON_SOCKET: harness.socketPath,
        MOCK_FIXTURE_DIR: harness.mockDir,
        NODE_OPTIONS: `--require=${harness.preloadPath}`,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function showTask(harness: Harness, id: number): Promise<TaskEntry> {
  const response = await sendRpc<{ task: TaskEntry; recent_ticks: string[] }>(
    harness.socketPath,
    { cmd: 'show', id },
  );
  return response.task;
}

async function waitForTerminalRun(harness: Harness, id: number): Promise<RunSnapshot> {
  let snapshot: RunSnapshot | undefined;
  const found = await waitUntil(async () => {
    const task = await showTask(harness, id);
    if (!task.run_id) return false;
    const runId = basename(task.run_id);
    const runPath = join(harness.fcHome, 'runs', runId);
    try {
      const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as RunSnapshot['state'];
      if (!(TERMINAL_STATUSES as readonly string[]).includes(state.status)) return false;
      snapshot = { task, runId, runPath, state };
      return true;
    } catch {
      return false;
    }
  }, 30_000);
  if (!found || !snapshot) throw new Error(`run for task #${id} did not reach a terminal record`);
  return snapshot;
}

function waitForHeldAgent(harness: Harness, pid: number, signal: AbortSignal): Promise<void> {
  const path = join(harness.mockDir, `held-${pid}`);
  if (existsSync(path)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      watcher.close();
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const inspect = (): void => { if (existsSync(path)) finish(); };
    const aborted = (): void => finish(signal.reason);
    const watcher = watch(harness.mockDir, { persistent: false }, inspect);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else inspect(); // A ready publication can precede watcher registration.
  });
}

async function waitForRecordedAgentPid(harness: Harness, unit: string): Promise<number> {
  let recorded: number | undefined;
  const found = await waitUntil(() => {
    const runningPath = join(harness.fcHome, 'supervise', safeUnit(unit), 'running.json');
    try {
      const running = JSON.parse(readFileSync(runningPath, 'utf-8')) as {
        shimPid?: number;
        agentPid?: number;
      };
      if (Number.isInteger(running.shimPid) && (running.shimPid ?? 0) > 0) {
        harness.ownedShimPids.add(running.shimPid!);
      }
      if (Number.isInteger(running.agentPid) && (running.agentPid ?? 0) > 0) {
        harness.ownedAgentPids.add(running.agentPid!);
        recorded = running.agentPid;
        return true;
      }
    } catch { /* launcher has not recorded the pid yet */ }
    return false;
  }, 5_000);
  if (!found || recorded === undefined) throw new Error(`no recorded agent pid for ${unit}`);
  return recorded;
}

function exitRecordExists(harness: Harness, unit: string): boolean {
  return existsSync(join(harness.fcHome, 'supervise', safeUnit(unit), 'exit.json'));
}

function safeUnit(unit: string): string {
  return unit.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function pidProbe(pid: number): 'alive' | 'esrch' | 'other-error' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'esrch';
    if (code === 'EPERM') return 'alive';
    return 'other-error';
  }
}

async function waitForCliResult<T>(
  read: () => T,
  accept: (result: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (!accept(last) && Date.now() < deadline) {
    await delay(50);
    last = read();
  }
  return last;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(50);
  }
  return check();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function cleanupHarness(harness: Harness): Promise<void> {
  collectRecordedPids(harness);
  try {
    await sendRpc(harness.socketPath, { cmd: 'stop' }, 500);
  } catch { /* a failed assertion may race daemon startup/exit */ }
  await waitUntil(() => harness.daemon.exitCode !== null, 1_000);
  if (harness.daemon.exitCode === null) harness.daemon.kill('SIGTERM');

  for (const pid of harness.ownedShimPids) signalOwnedPid(pid, 'SIGTERM', false);
  for (const pid of harness.ownedAgentPids) signalOwnedPid(pid, 'SIGTERM', true);
  await delay(100);
  for (const pid of harness.ownedShimPids) signalOwnedPid(pid, 'SIGKILL', false);
  for (const pid of harness.ownedAgentPids) signalOwnedPid(pid, 'SIGKILL', true);

  if (harness.root.startsWith(join(tmpdir(), 'fc-sl-'))) {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function collectRecordedPids(harness: Harness): void {
  const superviseDir = join(harness.fcHome, 'supervise');
  if (existsSync(superviseDir)) {
    for (const entry of readdirSync(superviseDir)) {
      try {
        const running = JSON.parse(readFileSync(join(superviseDir, entry, 'running.json'), 'utf-8')) as {
          shimPid?: number;
          agentPid?: number;
        };
        if (Number.isInteger(running.shimPid) && (running.shimPid ?? 0) > 0) harness.ownedShimPids.add(running.shimPid!);
        if (Number.isInteger(running.agentPid) && (running.agentPid ?? 0) > 0) harness.ownedAgentPids.add(running.agentPid!);
      } catch { /* no running record is normal for never-started/GC fixtures */ }
    }
  }
}

function signalOwnedPid(pid: number, signal: NodeJS.Signals, asGroup: boolean): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(asGroup && process.platform !== 'win32' ? -pid : pid, signal);
  } catch { /* already stopped */ }
}

function linkFirstAvailable(bin: string, name: string, candidates: string[]): void {
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) throw new Error(`required fixture command ${name} was not found in fixed candidates`);
  symlinkSync(source, join(bin, name));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function preloadSource(): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const childProcess = require('node:child_process');",
    "const { syncBuiltinESMExports } = require('node:module');",
    'const originalReadFileSync = fs.readFileSync;',
    'const originalExecFileSync = childProcess.execFileSync;',
    'const daemonServe = process.argv.includes(\'daemon\') && process.argv.includes(\'serve\');',
    "const briefIndex = process.argv.indexOf('--brief-input-base64');",
    "const brief = briefIndex >= 0 && process.argv[briefIndex + 1]",
    "  ? Buffer.from(process.argv[briefIndex + 1], 'base64url').toString('utf8')",
    "  : '';",
    'fs.readFileSync = function portableFixtureRead(path, ...args) {',
    '  const value = /^\\/proc\\/\\d+\\/(?:stat|cmdline)$/.test(String(path))',
    '    ? (() => { const error = new Error(`ENOENT: no procfs, open ${path}`); error.code = \'ENOENT\'; throw error; })()',
    '    : originalReadFileSync.call(this, path, ...args);',
    "  if (process.argv.includes('quick') && String(path).endsWith('/implement.json')) {",
    `    if (brief.includes('${HOLD_MARKER}')) {`,
    "      fs.writeFileSync(require('node:path').join(process.env.MOCK_FIXTURE_DIR, `held-${process.pid}`), 'ready');",
    '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '    }',
    '    try {',
    "      const fixture = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));",
    "      if (typeof fixture.output_text === 'string') process.stdout.write(`${fixture.output_text}\\n`);",
    '    } catch {}',
    '  }',
    '  return value;',
    '};',
    'childProcess.execFileSync = function portableFixtureExec(command, args, ...rest) {',
    "  if (String(command).endsWith('/ps') || command === 'ps') {",
    "    if (Array.isArray(args) && (args.includes('args=') || args.includes('lstart=')) && !args.includes('-ww')) {",
    "      throw new Error('portable ps probes must use -ww');",
    '    }',
    '  }',
    '  return originalExecFileSync.call(this, command, args, ...rest);',
    '};',
    'syncBuiltinESMExports();',
    `if (brief.includes('${EXIT_THREE_MARKER}')) process.exit(3);`,
    '',
  ].join('\n');
}
