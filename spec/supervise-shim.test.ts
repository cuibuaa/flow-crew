import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSystemd } from '../src/orchestrator.js';
import { isCancellationResult } from '../src/cancellation-client.js';
import { processIsAlive, processStartToken, processStartTokensMatch } from '../src/run-lock.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import {
  SUPERVISION_PROTOCOL_VERSION,
  atomicWriteJson,
  gcSupervisionDirectories,
  readSupervisionExit,
  readSupervisionRunning,
  runningRecordBindingStatus,
  supervisionPaths,
  type SupervisionLaunchRecord,
  type SupervisionRunningRecord,
} from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

const repositoryRoot = join(import.meta.dirname, '..');
const distOrchestrator = join(repositoryRoot, 'dist', 'orchestrator.js');
const DEAD_PID = 2_000_000_000;
const POLL_MS = 25;

let root: string;
let bin: string;
let previousPath: string | undefined;
let parent: ChildProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-shim-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  linkFirstAvailable(bin, 'ps', ['/bin/ps', '/usr/bin/ps']);
  previousPath = process.env.PATH;
  process.env.PATH = bin;
});

afterEach(async () => {
  if (parent?.exitCode === null) parent.kill('SIGKILL');
  parent = undefined;
  await stopOwnedSupervision(root);
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (root.startsWith(join(tmpdir(), 'fc-shim-'))) rmSync(root, { recursive: true, force: true });
});

describe('durable portable supervision shim', () => {
  it('keeps a recorded start-token kind mismatch as an immediate veto', () => {
    const token = processStartToken(process.pid);
    expect(token).toBeDefined();
    const record: SupervisionRunningRecord = {
      version: SUPERVISION_PROTOCOL_VERSION,
      shimPid: process.pid,
      shimToken: {
        kind: token?.kind === 'linux' ? 'posix-lstart' : 'linux',
        value: token?.value ?? 'missing',
      },
      shimCommand: "'the-token-mismatch-vetoes-command-fallback'",
      agentPid: process.pid,
      command: "'irrelevant'",
      startedAt: new Date().toISOString(),
    };

    expect(runningRecordBindingStatus(record)).toBe('unbound');
  });

  it('atomically records natural exit 3, keeps it above systemd active, and captures output', async () => {
    const unit = 'natural-three.service';
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh' });
    await backend.runUnit({
      unit,
      workingDirectory: root,
      command: shellJoin([
        process.execPath,
        '-e',
        'console.log("DURABLE_SHIM_OUTPUT"); process.exit(3)',
      ]),
    });

    const terminal = await waitForStatus(backend, unit, (status) => status.kind === 'terminal');
    const paths = supervisionPaths(root, unit);
    const running = readSupervisionRunning(paths.running);
    const exit = readSupervisionExit(paths.exit);

    expect(terminal).toEqual({ kind: 'terminal', exitCode: 3 });
    expect(running).toMatchObject({ command: expect.any(String), agentPid: expect.any(Number) });
    expect(running?.shimPid).not.toBe(running?.agentPid);
    expect(exit).toMatchObject({ exitCode: 3, normalized: 3, endedAt: expect.any(String) });
    expect(readdirSync(paths.unitDir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
    await expect(backend.journalTail(unit, 20)).resolves.toContain('DURABLE_SHIM_OUTPUT');

    installActiveSystemctl();
    await expect(backend.isActive(unit)).resolves.toEqual({ kind: 'terminal', exitCode: 3 });
  });

  it('lets a live systemd unit veto stale running evidence when exit.json is absent', async () => {
    const unit = 'systemd-veto.service';
    seedStaleRunning(unit, '2026-08-06T00:00:00.000Z');
    installActiveSystemctl();

    const backend = new NodeSystemd(root, { startupGraceMs: 0 });

    await expect(backend.isActive(unit)).resolves.toEqual({ kind: 'active' });
  });

  it('forwards TERM to the separate agent group, escalates to KILL, and normalizes the signal', async () => {
    const unit = 'forced-stop.service';
    const readyPath = join(root, 'ignore-term.ready');
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh', shutdownGraceMs: 100 });
    await backend.runUnit({
      unit,
      workingDirectory: root,
      command: shellJoin([
        process.execPath,
        '-e',
        `const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000)`,
      ]),
    });
    const paths = supervisionPaths(root, unit);
    const runningReady = await waitUntil(() => readSupervisionRunning(paths.running) !== undefined);
    expect(runningReady).toBe(true);
    const running = readSupervisionRunning(paths.running)!;
    expect(await waitUntil(() => existsSync(readyPath))).toBe(true);

    await backend.stopUnit(unit);
    const terminal = await waitForStatus(backend, unit, (status) => status.kind === 'terminal');
    const agentDead = await waitUntil(() => !processIsAlive(running.agentPid));

    expect(terminal).toEqual({
      kind: 'terminal',
      exitCode: 128 + constants.signals.SIGKILL,
      signal: 'SIGKILL',
    });
    expect(agentDead).toBe(true);
    expect(running.shimPid).not.toBe(running.agentPid);
  });

  it('drains a completed run child tree after a grace longer than the former settle window', async () => {
    const unit = 'completed-tree.service';
    const wrapperStatusPath = join(root, 'wrapper.status');
    const childPidPath = join(root, 'descendant.pid');
    const runPath = join(root, 'fixture-run');
    mkdirSync(runPath);
    installExecutable(
      bin,
      'systemd-run',
      [
        '#!/bin/sh',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --user|--unit=*|--property=*|--working-directory=*) shift ;;',
        '    *) break ;;',
        '  esac',
        'done',
        '"$@"',
        'wrapper_status=$?',
        `printf '%s\\n' "$wrapper_status" > ${shellQuote(wrapperStatusPath)}`,
        'exit "$wrapper_status"',
        '',
      ].join('\n'),
    );
    const descendantSource = [
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const agentSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const descendant = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
      'descendant.once("spawn", () => {',
      '  descendant.unref();',
      `  writeFileSync(${JSON.stringify(childPidPath)}, String(descendant.pid));`,
      `  writeFileSync(${JSON.stringify(join(runPath, 'run.json'))}, JSON.stringify({ status: "complete" }));`,
      '  setTimeout(() => process.exit(0), 50);',
      '});',
      'descendant.once("error", (error) => { throw error; });',
    ].join('\n');
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh', shutdownGraceMs: 2_500 });
    let descendantPid: number | undefined;
    try {
      await backend.runUnit({
        unit,
        workingDirectory: root,
        command: shellJoin([process.execPath, '-e', agentSource]),
      });

      descendantPid = Number.parseInt(readFileSync(childPidPath, 'utf-8'), 10);
      const paths = supervisionPaths(root, unit);
      const running = readSupervisionRunning(paths.running);
      const exit = readSupervisionExit(paths.exit);

      expect(
        processIsAlive(descendantPid),
        `descendant ${descendantPid} survived wrapper exit`,
      ).toBe(false);
      expect(running).toBeDefined();
      expect(processIsAlive(running!.shimPid)).toBe(false);
      expect(readFileSync(wrapperStatusPath, 'utf-8').trim()).toBe('0');
      expect(JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8'))).toEqual({ status: 'complete' });
      expect(exit).toMatchObject({ exitCode: 0, normalized: 0 });
      await expect(backend.isActive(unit)).resolves.toEqual({ kind: 'terminal', exitCode: 0 });
    } finally {
      if (descendantPid && processIsAlive(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* test-owned child already exited */ }
        await waitUntil(() => !processIsAlive(descendantPid!));
      }
    }
  });

  it('makes stale running evidence a non-retrying cancellation outcome unknown', async () => {
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({
      brief_text: 'terminal unknown cancellation fixture',
      projectDir: root,
      status: TASK_STATUS.RUNNING,
    });
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh' });
    await backend.runUnit({
      unit: task.systemd_unit,
      workingDirectory: root,
      command: shellJoin([process.execPath, '-e', 'setInterval(() => {}, 1000)']),
    });
    const paths = supervisionPaths(root, task.systemd_unit);
    expect(await waitUntil(() => readSupervisionRunning(paths.running) !== undefined)).toBe(true);
    const running = readSupervisionRunning(paths.running)!;
    process.kill(running.shimPid, 'SIGKILL');
    expect(await waitUntil(() => !processIsAlive(running.shimPid))).toBe(true);
    expect(processIsAlive(running.agentPid)).toBe(true);
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: backend,
      timeoutMs: 0,
      signalGraceMs: 0,
    });

    const result = await coordinator.cancelTask(task.id);

    expect(result).toMatchObject({
      ok: false,
      status: 'outcome-unknown',
      observation: {
        unitState: { kind: 'terminal-unknown', reason: 'shim-died-without-status' },
      },
    });
    expect(result.message).toContain('may still be running');
    expect(registry.get(task.id)).toMatchObject({ status: TASK_STATUS.STUCK });
    expect(registry.get(task.id)?.cancellation_unobservable_count).toBeUndefined();
    expect(processIsAlive(running.agentPid)).toBe(true);
    expect(isCancellationResult(result, { taskId: task.id })).toBe(true);
    expect(isCancellationResult({ ...result, ok: true, status: 'cancelled' }, { taskId: task.id })).toBe(false);
  });

  it('persists an asynchronous shim launcher ENOENT without crashing the owner', async () => {
    const unit = 'missing-launcher.service';
    const backend = new NodeSystemd(root, {
      nodePath: join(root, 'missing-node'),
      shellPath: '/bin/sh',
    });

    await backend.runUnit({ unit, workingDirectory: root, command: shellJoin([process.execPath, '-e', '']) });
    const terminal = await waitForStatus(backend, unit, (status) => status.kind === 'terminal');
    const legacy = JSON.parse(
      readFileSync(join(root, 'systemd-fallback', `${unit}.json`), 'utf-8'),
    ) as { reason?: string };

    expect(terminal).toEqual({ kind: 'terminal', exitCode: 127 });
    expect(legacy.reason).toMatch(/shim launcher spawn failed:.*ENOENT/);
  });

  it('keeps an early shim exit without running evidence outcome-unknown', async () => {
    const unit = 'early-shim-exit.service';
    const orphanPidPath = join(root, 'early-shim-agent.pid');
    const fakeShimPath = join(root, 'early-shim.mjs');
    writeFileSync(fakeShimPath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(orphanPidPath)}, String(agent.pid));`,
      'agent.unref();',
    ].join('\n'), 'utf-8');
    const backend = new NodeSystemd(root, {
      shimPath: fakeShimPath,
      shellPath: '/bin/sh',
      startupGraceMs: 50,
    });
    let orphanPid: number | undefined;
    let orphanToken: ReturnType<typeof processStartToken>;
    try {
      await backend.runUnit({
        unit,
        workingDirectory: root,
        command: shellJoin([process.execPath, '-e', '']),
      });
      expect(await waitUntil(() => existsSync(orphanPidPath))).toBe(true);
      const parsedPid = Number.parseInt(readFileSync(orphanPidPath, 'utf-8'), 10);
      expect(Number.isSafeInteger(parsedPid) && parsedPid > 1).toBe(true);
      orphanPid = parsedPid;
      orphanToken = processStartToken(parsedPid);
      expect(orphanToken).toBeDefined();
      expect(processIsAlive(parsedPid)).toBe(true);

      const status = await waitForStatus(
        backend,
        unit,
        (candidate) => candidate.kind === 'terminal-unknown',
      );

      expect(status).toEqual({ kind: 'terminal-unknown', reason: 'never-started' });
      expect(existsSync(supervisionPaths(root, unit).exit)).toBe(false);
      expect(processIsAlive(parsedPid)).toBe(true);
    } finally {
      if (orphanPid && orphanToken) {
        const ownedPid = orphanPid;
        const ownedToken = orphanToken;
        signalBound(ownedPid, ownedToken, 'SIGTERM', true);
        const stoppedAfterTerm = await waitUntil(() => !processIsAlive(ownedPid), 250);
        if (!stoppedAfterTerm) signalBound(ownedPid, ownedToken, 'SIGKILL', true);
        await waitUntil(() => !processIsAlive(ownedPid));
      }
    }
  });

  it('recovers exit 42 after the launching parent has exited', async () => {
    const unit = 'parent-exited.service';
    const source = [
      `import { NodeSystemd } from ${JSON.stringify(pathToFileURL(distOrchestrator).href)};`,
      `const backend = new NodeSystemd(${JSON.stringify(root)}, { shellPath: '/bin/sh' });`,
      'const quote = String.fromCharCode(39);',
      `const command = [${JSON.stringify(process.execPath)}, '-e', 'setTimeout(() => process.exit(42), 250)']`,
      '  .map((part) => quote + part + quote).join(" ");',
      `await backend.runUnit({ unit: ${JSON.stringify(unit)}, workingDirectory: ${JSON.stringify(root)}, command });`,
    ].join('\n');
    let parentOutput = '';
    parent = spawn(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HOME: root,
          FC_HOME: root,
          PATH: bin,
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    parent.stdout?.on('data', (chunk) => { parentOutput += String(chunk); });
    parent.stderr?.on('data', (chunk) => { parentOutput += String(chunk); });
    const parentExit = await waitForChild(parent);
    expect(parentExit, parentOutput).toBe(0);
    parent = undefined;

    const independentReader = new NodeSystemd(root);
    const recovered = await waitForStatus(
      independentReader,
      unit,
      (status) => status.kind === 'terminal',
    );

    expect(recovered).toEqual({ kind: 'terminal', exitCode: 42 });
    expect(readSupervisionExit(supervisionPaths(root, unit).exit)?.normalized).toBe(42);
  });

  it('garbage-collects only old directories with valid exit evidence', () => {
    const old = supervisionPaths(root, 'old-terminal.service');
    const uncertain = supervisionPaths(root, 'uncertain.service');
    atomicWriteJson(old.exit, {
      version: SUPERVISION_PROTOCOL_VERSION,
      exitCode: 0,
      normalized: 0,
      endedAt: '2020-01-01T00:00:00.000Z',
    });
    seedStaleRunning('uncertain.service', '2020-01-01T00:00:00.000Z');

    const removed = gcSupervisionDirectories(root, {
      nowMs: Date.parse('2026-08-06T00:00:00.000Z'),
      retentionMs: 1_000,
    });

    expect(removed).toBe(1);
    expect(existsSync(old.unitDir)).toBe(false);
    expect(existsSync(uncertain.unitDir)).toBe(true);
  });
});

function seedStaleRunning(unit: string, createdAt: string): void {
  const paths = supervisionPaths(root, unit);
  const launch: SupervisionLaunchRecord = {
    version: SUPERVISION_PROTOCOL_VERSION,
    unit,
    workingDirectory: root,
    command: "'stale-agent'",
    nodePath: process.execPath,
    shellPath: '/bin/sh',
    createdAt,
    shutdownGraceMs: 100,
  };
  const running: SupervisionRunningRecord = {
    version: SUPERVISION_PROTOCOL_VERSION,
    shimPid: DEAD_PID,
    shimToken: { kind: 'linux', value: '1' },
    shimCommand: "'stale-shim'",
    agentPid: DEAD_PID - 1,
    agentToken: { kind: 'linux', value: '1' },
    command: launch.command,
    startedAt: createdAt,
  };
  atomicWriteJson(paths.launch, launch);
  atomicWriteJson(paths.running, running);
}

function installActiveSystemctl(): void {
  const path = join(bin, 'systemctl');
  writeFileSync(path, '#!/bin/sh\necho active\n', 'utf-8');
  chmodSync(path, 0o755);
}

function installExecutable(targetDir: string, name: string, source: string): void {
  const path = join(targetDir, name);
  writeFileSync(path, source, 'utf-8');
  chmodSync(path, 0o755);
}

function shellJoin(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForStatus(
  backend: NodeSystemd,
  unit: string,
  accept: (status: Awaited<ReturnType<NodeSystemd['isActive']>>) => boolean,
  timeoutMs = 5_000,
) {
  let status = await backend.isActive(unit);
  const reached = await waitUntil(async () => {
    status = await backend.isActive(unit);
    return accept(status);
  }, timeoutMs);
  expect(reached, `last unit status: ${JSON.stringify(status)}`).toBe(true);
  return status;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
  return check();
}

async function waitForChild(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code) => resolveExit(code));
  });
}

async function stopOwnedSupervision(baseDir: string): Promise<void> {
  const superviseRoot = join(baseDir, 'supervise');
  let entries: string[] = [];
  try { entries = readdirSync(superviseRoot); } catch { return; }
  const records = entries.flatMap((entry) => {
    const running = readSupervisionRunning(join(superviseRoot, entry, 'running.json'));
    return running ? [running] : [];
  });
  for (const running of records) signalBound(running.shimPid, running.shimToken, 'SIGTERM', false);
  for (const running of records) signalBound(running.agentPid, running.agentToken, 'SIGTERM', true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  for (const running of records) signalBound(running.shimPid, running.shimToken, 'SIGKILL', false);
  for (const running of records) signalBound(running.agentPid, running.agentToken, 'SIGKILL', true);
}

function signalBound(
  pid: number,
  token: SupervisionRunningRecord['shimToken'],
  signal: NodeJS.Signals,
  asGroup: boolean,
): void {
  if (!processStartTokensMatch(token, processStartToken(pid))) return;
  try { process.kill(asGroup && process.platform !== 'win32' ? -pid : pid, signal); } catch { /* stopped */ }
}

function linkFirstAvailable(targetDir: string, name: string, candidates: string[]): void {
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) throw new Error(`required fixture command ${name} was not found`);
  symlinkSync(source, join(targetDir, name));
}

describe('the agent runs under a login shell', () => {
  // v0.6.0 shipped `-c` instead of `-lc`. The systemd user manager's PATH does
  // not include nvm or ~/.local/bin, so every launch failed with "No adapter
  // CLI is installed or visible on PATH" on a machine where codex was plainly
  // installed. Three CI axes missed it because a runner's PATH is already
  // complete — so this asserts the flag, which is the thing that actually
  // differs, rather than trying to reproduce an incomplete PATH.
  it('passes -lc so the login profile is sourced', () => {
    const source = readFileSync(
      new URL('../src/supervise-shim.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("spawn(launch.shellPath, ['-lc', launch.command]");
    expect(source).not.toContain("spawn(launch.shellPath, ['-c', launch.command]");
  });
});
