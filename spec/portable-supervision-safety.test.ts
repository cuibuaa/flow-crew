/**
 * Regression invariant: portable supervision binds process identity before
 * signalling, owns the complete agent process group, and fails closed when
 * lifecycle evidence is ambiguous.
 *
 * Maintenance contract: this is a permanent cross-platform regression suite,
 * not a run-specific gate artifact. Keep it active in the default Vitest set.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommand, NodeSystemd } from '../src/orchestrator.js';
import {
  isLiveFlowcrewSchedulerForRun,
  processIsAlive,
  processStartToken,
  processStartTokensMatch,
} from '../src/run-lock.js';
import {
  CancellationObservationLimitError,
  RunCancellationCoordinator,
} from '../src/run-control.js';
import {
  readSupervisionRunning,
  supervisionPaths,
  type SupervisorBackend,
  type UnitStatus,
} from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

const TERMINATION_WAIT_MS = 5_000;
const POLL_MS = 25;

let fixtureRoot: string;
let emptyBin: string;
let previousPath: string | undefined;
const ownedProcessGroups = new Set<number>();
const ownedShimPids = new Set<number>();
const ownedChildren = new Set<ChildProcess>();

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'fc-portable-safety-'));
  emptyBin = join(fixtureRoot, 'bin');
  mkdirSync(emptyBin);
  previousPath = process.env.PATH;
  process.env.PATH = emptyBin;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pid of ownedProcessGroups) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
    } catch {
      // The owned group already exited.
    }
  }
  ownedProcessGroups.clear();
  const shimsExited = await waitUntil(() => (
    [...ownedShimPids].every((pid) => !processIsAlive(pid))
  ));
  if (!shimsExited) {
    for (const pid of ownedShimPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* test-owned shim already exited */ }
    }
    await waitUntil(() => [...ownedShimPids].every((pid) => !processIsAlive(pid)));
  }
  ownedShimPids.clear();
  for (const child of ownedChildren) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  ownedChildren.clear();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function shellJoin(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = TERMINATION_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
  return predicate();
}

function fallbackRecordPath(baseDir: string, unit: string): string {
  return join(baseDir, 'systemd-fallback', `${unit}.json`);
}

async function launchOwnedProcessTree(
  backend: NodeSystemd,
  baseDir: string,
  unit: string,
  includeApostrophe = false,
): Promise<{ groupPid: number; agentPid: number; childPid: number; recordPath: string }> {
  const pidPath = join(baseDir, `${unit}.pids`);
  const agentSource = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + "," + String(child.pid));`,
    'process.on("SIGTERM", () => {',
    '  const forced = setTimeout(() => process.exit(7), 1500);',
    '  child.once("exit", () => { clearTimeout(forced); process.exit(0); });',
    '});',
    includeApostrophe
      ? 'console.log("portable operator\'s quoted-command sentinel");'
      : 'console.log("portable-supervision-log-sentinel");',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  await backend.runUnit({
    unit,
    workingDirectory: baseDir,
    command: shellJoin([process.execPath, '-e', agentSource]),
  });

  const recordPath = fallbackRecordPath(baseDir, unit);
  const initialized = await waitUntil(() => existsSync(pidPath) && existsSync(recordPath));
  expect(initialized, `fallback unit ${unit} never initialized`).toBe(true);
  const [agentPid, childPid] = readFileSync(pidPath, 'utf-8').split(',').map(Number);
  const recorded = JSON.parse(readFileSync(recordPath, 'utf-8')) as { pid?: number };
  expect(recorded.pid).toEqual(expect.any(Number));
  const running = readSupervisionRunning(supervisionPaths(baseDir, unit).running);
  expect(running).toBeDefined();
  ownedShimPids.add(running!.shimPid);
  const groupPid = recorded.pid!;
  ownedProcessGroups.add(groupPid);
  return { groupPid, agentPid, childPid, recordPath };
}

class PersistentlyActiveUnits implements SupervisorBackend {
  stopCalls = 0;

  async isActive(): Promise<UnitStatus> {
    return { kind: 'active' };
  }

  async runUnit(): Promise<void> {}

  async stopUnit(): Promise<void> {
    this.stopCalls += 1;
  }

  async journalTail(): Promise<string> { return ''; }
}

describe('portable supervision safety invariants', () => {
  it('keeps the portable identity, group signal, and ENOENT authority in one safety bundle', () => {
    const orchestrator = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf-8');
    expect(orchestrator).toContain('processStartTokensMatch(recordedToken, processStartToken(fallbackPid))');
    expect(orchestrator).toContain("const signalTarget = process.platform !== 'win32' ? -fallbackPid : fallbackPid");
    expect(orchestrator).toContain("if (failure.code === 'ENOENT') return this.fallbackState(unit)");
    expect(orchestrator).toContain('startTimeTicks: startToken.value');
    expect(orchestrator).toContain('startTokenKind: startToken.kind');
  });

  it('uses an ENOENT fallback terminal record authoritatively without deleting it', async () => {
    const unit = 'gate-enoent-terminal.service';
    const backend = new NodeSystemd(fixtureRoot);
    const recordPath = fallbackRecordPath(fixtureRoot, unit);
    writeFileSync(recordPath, JSON.stringify({ state: 'inactive', completedAt: '2026-08-06T00:00:00.000Z' }));

    await expect(backend.isActive(unit)).resolves.toEqual({
      kind: 'terminal-unknown',
      reason: 'fallback process ended without an exit status (inactive)',
    });
    expect(JSON.parse(readFileSync(recordPath, 'utf-8'))).toMatchObject({
      state: 'inactive',
      completedAt: '2026-08-06T00:00:00.000Z',
    });
  });

  it('keeps a present but failing systemctl probe fail-closed', async () => {
    const unit = 'gate-present-systemctl.service';
    const backend = new NodeSystemd(fixtureRoot);
    const recordPath = fallbackRecordPath(fixtureRoot, unit);
    const fakeSystemctl = join(emptyBin, 'systemctl');
    writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(recordPath, JSON.stringify({ state: 'inactive' }));

    await expect(backend.isActive(unit)).resolves.toEqual({
      kind: 'unobservable',
      reason: 'systemctl probe failed',
    });
  });

  it('signals the detached process group so both the agent and its child die', async () => {
    const unit = 'gate-group-stop.service';
    const backend = new NodeSystemd(fixtureRoot, { shellPath: '/bin/sh' });
    const launched = await launchOwnedProcessTree(backend, fixtureRoot, unit);

    try {
      await backend.stopUnit(unit);
    } catch (error) {
      const record = readFileSync(launched.recordPath, 'utf-8');
      throw new Error(
        `owned process-group stop was refused: ${error instanceof Error ? error.message : String(error)}; record=${record}`,
      );
    }
    const wholeTreeIsDead = await waitUntil(() => (
      !processIsAlive(launched.groupPid)
      && !processIsAlive(launched.agentPid)
      && !processIsAlive(launched.childPid)
    ));

    expect(
      wholeTreeIsDead,
      `group=${launched.groupPid}, agent=${launched.agentPid}, child=${launched.childPid}`,
    ).toBe(true);
    ownedProcessGroups.delete(launched.groupPid);
  });

  it('refuses to signal a live process when the recorded command no longer binds', async () => {
    const unit = 'gate-command-mismatch.service';
    const backend = new NodeSystemd(fixtureRoot, { shellPath: '/bin/sh' });
    const launched = await launchOwnedProcessTree(backend, fixtureRoot, unit);
    const record = JSON.parse(readFileSync(launched.recordPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(launched.recordPath, JSON.stringify({ ...record, command: "'not-the-owned-agent'" }));

    await expect(backend.stopUnit(unit)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.isActive(unit)).resolves.toEqual({ kind: 'active' });
    expect(processIsAlive(launched.groupPid)).toBe(true);
    expect(processIsAlive(launched.agentPid)).toBe(true);
  });

  it('binds and stops a shell-escaped command containing an apostrophe', async () => {
    const unit = 'gate-quoted-command.service';
    const backend = new NodeSystemd(fixtureRoot, { shellPath: '/bin/sh' });
    const launched = await launchOwnedProcessTree(backend, fixtureRoot, unit, true);

    await backend.stopUnit(unit);
    const agentDead = await waitUntil(() => !processIsAlive(launched.agentPid));

    expect(agentDead, `quoted command agent ${launched.agentPid} survived`).toBe(true);
    ownedProcessGroups.delete(launched.groupPid);
  });

  it('continues to bind a pre-change v1 identity file on Linux', () => {
    const runPath = join(fixtureRoot, 'v1-run');
    mkdirSync(runPath);
    const token = processStartToken(process.pid);
    writeFileSync(join(runPath, 'scheduler.identity.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      runId: 'v1-run',
      linuxStartTimeTicks: token?.value,
    }));

    expect(isLiveFlowcrewSchedulerForRun(process.pid, 'v1-run', runPath)).toBe(token?.kind === 'linux');
    expect(processStartTokensMatch(token, token)).toBe(token !== undefined);
    if (token) {
      const otherKind = token.kind === 'linux' ? 'posix-lstart' as const : 'linux' as const;
      expect(processStartTokensMatch({ kind: otherKind, value: token.value }, token)).toBe(false);
    }
  });

  it('does not let a scheduler-shaped argv override a v2 token-kind mismatch', async () => {
    const runId = 'v2-kind-mismatch';
    const runPath = join(fixtureRoot, runId);
    mkdirSync(runPath);
    const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
        cliPath,
        'quick',
        '--existing-run-id',
        runId,
      ],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          HOME: fixtureRoot,
          FC_HOME: fixtureRoot,
        },
        stdio: 'ignore',
      },
    );
    ownedChildren.add(child);
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    let token: ReturnType<typeof processStartToken> = undefined;
    const tokenVisible = await waitUntil(() => {
      token = processStartToken(child.pid!);
      return token !== undefined;
    });
    expect(tokenVisible).toBe(true);
    expect(token).toBeDefined();
    const mismatchedKind = token?.kind === 'linux' ? 'posix-lstart' as const : 'linux' as const;
    writeFileSync(join(runPath, 'scheduler.identity.json'), JSON.stringify({
      version: 2,
      pid: child.pid,
      runId,
      startToken: { kind: mismatchedKind, value: token?.value },
      command: 'the token mismatch must veto every compatibility path',
    }));

    expect(isLiveFlowcrewSchedulerForRun(child.pid!, runId, runPath)).toBe(false);
  });

  it('treats EPERM as alive and ESRCH as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    expect(processIsAlive(123_456)).toBe(true);

    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(processIsAlive(123_456)).toBe(false);
  });

  it('captures fallback output and persists asynchronous spawn ENOENT', async () => {
    const loggingUnit = 'gate-log.service';
    const backend = new NodeSystemd(fixtureRoot, { shellPath: '/bin/sh' });
    const launched = await launchOwnedProcessTree(backend, fixtureRoot, loggingUnit);
    let tailed = '';
    await waitUntil(async () => {
      tailed = await backend.journalTail(loggingUnit, 20);
      return tailed.includes('portable-supervision-log-sentinel');
    });
    expect(tailed).toContain('portable-supervision-log-sentinel');

    const failingUnit = 'gate-spawn-error.service';
    const failing = new NodeSystemd(fixtureRoot, { shellPath: join(fixtureRoot, 'missing-shell') });
    await failing.runUnit({ unit: failingUnit, workingDirectory: fixtureRoot, command: "'ignored'" });
    const failedRecord = fallbackRecordPath(fixtureRoot, failingUnit);
    const persisted = await waitUntil(() => {
      try {
        return JSON.parse(readFileSync(failedRecord, 'utf-8')).state === 'failed';
      } catch {
        return false;
      }
    });
    expect(persisted).toBe(true);
    expect(String(JSON.parse(readFileSync(failedRecord, 'utf-8')).reason)).toMatch(/spawn failed:.*ENOENT/);
    expect(processIsAlive(launched.agentPid)).toBe(true);
  });

  it('builds the supervised command with the daemon absolute Node interpreter', () => {
    const registry = new TaskRegistry({ baseDir: fixtureRoot });
    const task = registry.create({ config_path: join(fixtureRoot, 'campaign.yml'), projectDir: fixtureRoot });

    const command = buildCommand(task, join(fixtureRoot, 'cli.js'));

    expect(command.startsWith(`'${process.execPath}' `)).toBe(true);
    expect(command.startsWith("'node' ")).toBe(false);
  });

  it('exhausts retries for every persistently nonterminal observation', async () => {
    const registry = new TaskRegistry({ baseDir: fixtureRoot });
    const units = new PersistentlyActiveUnits();
    const task = registry.create({
      brief_text: 'persistent active cancellation fixture',
      projectDir: fixtureRoot,
      status: TASK_STATUS.RUNNING,
    });
    const coordinator = (): RunCancellationCoordinator => new RunCancellationCoordinator({
      registry,
      units,
      timeoutMs: 0,
      signalGraceMs: 0,
      maxUnobservableObservations: 2,
    });

    await expect(coordinator().cancelTask(task.id)).resolves.toMatchObject({ ok: false, status: 'cancelling' });
    await expect(coordinator().cancelTask(task.id)).rejects.toBeInstanceOf(CancellationObservationLimitError);
    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.STUCK);
    const callsAtLimit = units.stopCalls;
    await expect(coordinator().cancelTask(task.id)).rejects.toBeInstanceOf(CancellationObservationLimitError);
    expect(units.stopCalls).toBe(callsAtLimit);
  });
});
