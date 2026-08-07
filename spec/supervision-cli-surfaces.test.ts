/**
 * Regression invariant: CLI and dashboard supervision surfaces expose the
 * durable backend truth, follow portable logs without gaps, and remain usable
 * without systemd, procfs, or a shell `which` helper.
 *
 * Maintenance contract: this is a permanent user-surface regression suite,
 * not a run-specific gate artifact. Keep it active in the default Vitest set.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutableOnPath } from '../src/adapters/availability.js';
import { mergeTaskWithRunState } from '../src/cli-daemon.js';
import { detectSupervisorBackend } from '../src/cli-doctor.js';
import { hasLiveDirectRunner } from '../src/dashboard.js';
import {
  startRpcServer,
  type RpcRequest,
  type RpcResponse,
} from '../src/orchestrator-rpc.js';
import { TaskRegistry } from '../src/task-registry.js';

const repositoryRoot = join(import.meta.dirname, '..');
const distCli = join(repositoryRoot, 'dist', 'cli.js');
const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];

interface Fixture {
  root: string;
  home: string;
  fcHome: string;
  project: string;
  bin: string;
  socketPath: string;
}

interface CliCapture {
  child: ChildProcess;
  output: () => string;
  errorOutput: () => string;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('supervision CLI surface invariants', () => {
  it('follows a portable log through the real CLI and daemon RPC response', async () => {
    const fixture = createFixture();
    const logPath = join(fixture.root, 'out.log');
    writeFileSync(logPath, 'initial-portable-line\n', 'utf-8');
    const requests: RpcRequest[] = [];
    const server = await startRpcServer(fixture.socketPath, (request): RpcResponse => {
      requests.push(request);
      // Model an agent write after the daemon captured its tail snapshot but
      // before the CLI has installed its file follower. A correct follow path
      // must not create a blind interval between those two operations.
      appendFileSync(logPath, 'between-snapshot-and-follow\n', 'utf-8');
      return {
        output: 'initial-portable-line\n',
        source: { kind: 'file', path: logPath },
      };
    });
    servers.push(server);

    const cli = spawnRealCli(fixture, ['task', 'tail', '41', '--tail', '7', '--follow']);
    expect(await waitUntil(() => cli.output().includes('initial-portable-line'), 5_000)).toBe(true);
    appendFileSync(logPath, 'appended-portable-sentinel\n', 'utf-8');
    expect(await waitUntil(() => cli.output().includes('appended-portable-sentinel'), 5_000)).toBe(true);
    cli.child.kill('SIGTERM');
    const result = await waitForExit(cli.child, 5_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(requests).toEqual([{ cmd: 'tail', id: 41, lines: 7, follow: true }]);
    expect(cli.output()).toContain('between-snapshot-and-follow');
    expect(cli.errorOutput()).not.toMatch(/ENOENT|\n\s+at\s/);
  });

  it('reports unavailable journal follow without an ENOENT stack in the real CLI', async () => {
    const fixture = createFixture();
    const server = await startRpcServer(fixture.socketPath, (): RpcResponse => ({
      output: '',
      source: { kind: 'journal', unit: 'flowcrew-task-42.service' },
    }));
    servers.push(server);

    const cli = spawnRealCli(fixture, ['task', 'tail', '42', '--follow']);
    const result = await waitForExit(cli.child, 5_000);

    expect(result).toEqual({ code: 1, signal: null });
    expect(cli.errorOutput()).toContain('journalctl is not installed and no portable log exists');
    expect(cli.errorOutput()).not.toMatch(/ENOENT|\n\s+at\s/);
  });

  it('renders merged run outcome and normalized supervisor exit through the real CLI', async () => {
    const fixture = createFixture();
    const runRoot = join(fixture.fcHome, 'runs');
    const runId = 'supervision-terminal-run';
    const runPath = join(runRoot, runId);
    mkdirSync(runPath, { recursive: true });
    const registry = new TaskRegistry({ baseDir: fixture.fcHome });
    const stale = registry.create({
      projectDir: fixture.project,
      name: 'supervision merged show',
      run_id: runId,
      status: 'running',
    });
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      status: 'complete',
      completedAt: '2026-08-06T20:04:00.000Z',
      verdict: { verdict: 'PASS' },
    }), 'utf-8');
    const merged = mergeTaskWithRunState(stale, runRoot);
    const server = await startRpcServer(fixture.socketPath, (request): RpcResponse => {
      if (request.cmd !== 'show') return { error: 'unexpected request' };
      return {
        task: merged,
        recent_ticks: [],
        unit_status: { kind: 'terminal', exitCode: 3 },
        exit_code: 3,
      };
    });
    servers.push(server);

    const cli = spawnRealCli(fixture, ['task', 'show', String(stale.id)]);
    const result = await waitForExit(cli.child, 5_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(cli.output()).toContain('Status: complete');
    expect(cli.output()).toContain('Verdict: PASS');
    expect(cli.output()).toContain('Completed: 2026-08-06T20:04:00.000Z');
    expect(cli.output()).toContain('Exit code: 3');
    expect(registry.get(stale.id)?.status).toBe('running');
  });

  it('recognizes the active dist CLI and portable shim with a PATH containing no which', async () => {
    const fixture = createFixture();
    symlinkSync(distCli, join(fixture.bin, 'flowcrew'));
    expect(existsSync(join(fixture.bin, 'which'))).toBe(false);

    const cli = spawnRealCli(fixture, ['doctor']);
    const result = await waitForExit(cli.child, 10_000);
    const combined = `${cli.output()}${cli.errorOutput()}`;

    expect(result.code).toBe(0);
    expect(combined).toContain('flowcrew CLI: This install is available on PATH');
    expect(combined).toContain('Process supervision: portable Node shim');
    expect(combined).not.toContain('not found on PATH. Run `npm link`');
  });

  it('resolves an adapter executable directly while rejecting a non-executable peer', () => {
    const fixture = createFixture();
    const codex = join(fixture.bin, 'codex');
    const claude = join(fixture.bin, 'claude');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n', 'utf-8');
    writeFileSync(claude, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(codex, 0o755);
    chmodSync(claude, 0o644);

    expect(existsSync(join(fixture.bin, 'which'))).toBe(false);
    expect(findExecutableOnPath('codex', fixture.bin)).toBe(codex);
    expect(findExecutableOnPath('claude', fixture.bin)).toBeUndefined();
  });

  it('treats EPERM as live when procfs is unavailable', () => {
    const fixture = createFixture();
    const runId = 'supervision-eperm-runner';
    const markerDir = join(fixture.project, '.fc');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `direct-resume-${runId}.pid`), '321', 'utf-8');

    const live = hasLiveDirectRunner(fixture.project, runId, {
      procRoot: join(fixture.root, 'missing-proc'),
      killProcess: () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); },
    });

    expect(live).toBe(true);
  });

  it('treats ESRCH as dead when procfs is unavailable', () => {
    const fixture = createFixture();
    const runId = 'supervision-esrch-runner';
    const markerDir = join(fixture.project, '.fc');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `direct-rerun-${runId}.pid`), '654', 'utf-8');

    const live = hasLiveDirectRunner(fixture.project, runId, {
      procRoot: join(fixture.root, 'missing-proc'),
      killProcess: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });

    expect(live).toBe(false);
  });

  it('does not advertise a systemd cgroup wrapper when systemd-run is absent', async () => {
    const fixture = createFixture();
    symlinkSync(distCli, join(fixture.bin, 'flowcrew'));
    const systemctl = join(fixture.bin, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(systemctl, 0o755);
    expect(existsSync(join(fixture.bin, 'systemd-run'))).toBe(false);

    const lookedUp: string[] = [];
    const report = detectSupervisorBackend({
      findCommand: (command) => {
        lookedUp.push(command);
        return command === 'systemctl' ? '/fixture/systemctl' : undefined;
      },
      runCommand: () => { /* the injected user-manager probe succeeds */ },
    });
    const cli = spawnRealCli(fixture, ['doctor']);
    const result = await waitForExit(cli.child, 10_000);
    const combined = `${cli.output()}${cli.errorOutput()}`;

    expect({ lookedUp, reportKind: report.kind, exitCode: result.code, output: combined }).toMatchObject({
      lookedUp: expect.arrayContaining(['systemctl', 'systemd-run']),
      reportKind: 'portable-shim',
      exitCode: 0,
      output: expect.stringContaining('Process supervision: portable Node shim (systemd user session unavailable'),
    });
    expect(combined).not.toContain('available systemd user-session cgroup wrapper');
  });

  it('keeps all seven supervised lifecycle assertions active', () => {
    const source = readFileSync(join(import.meta.dirname, 'supervised-lifecycle.test.ts'), 'utf-8');
    for (let assertion = 1; assertion <= 7; assertion += 1) {
      expect(source).toMatch(new RegExp(`\\bit\\(['\"]\\[${assertion}\\]`));
    }
    expect(source).not.toMatch(/\bit\.(?:fails|skip|todo)\s*\(/);
  });
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'fc-supervision-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const fcHome = join(root, 'state');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const socketPath = join(root, 'q.sock');
  for (const directory of [home, fcHome, project, bin]) mkdirSync(directory, { recursive: true });
  mkdirSync(join(project, 'config', 'agents'), { recursive: true });
  writeFileSync(join(project, 'config', 'defaults.yaml'), 'adapter: auto\n', 'utf-8');
  expect(socketPath.length).toBeLessThan(104);
  return { root, home, fcHome, project, bin, socketPath };
}

function spawnRealCli(fixture: Fixture, args: string[]): CliCapture {
  let stdout = '';
  let stderr = '';
  const child = spawn(
    process.execPath,
    [distCli, ...args, '--socket', fixture.socketPath],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: fixture.home,
        FC_HOME: fixture.fcHome,
        PROJECT_DIR: fixture.project,
        PATH: fixture.bin,
        FLOWCREW_DAEMON_SOCKET: fixture.socketPath,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', (error) => { stderr += `${error.message}\n`; });
  return { child, output: () => stdout, errorOutput: () => stderr };
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`CLI child ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return check();
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
