import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { handleDaemonCancellationRequest } from '../src/cli-daemon.js';
import { NodeSystemd, Orchestrator, type GitAdapter, type SupervisorBackend, type UnitStatus } from '../src/orchestrator.js';
import {
  activeRunsByProject,
  claimLaunchIntent,
  findLiveRunOwnerForProject,
  invalidateRunLockCache,
  isLiveFlowcrewSchedulerForRun,
  isProjectBusy,
  releaseLaunchIntent,
  writeSchedulerProcessIdentity,
} from '../src/run-lock.js';
import {
  RunCancellationCoordinator,
  type CancellationResult,
} from '../src/run-control.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  fcGlobalDir,
  readRunState,
  RUN_STATUS,
  runsRoot,
  setFcGlobalDir,
  STAGE_STATUS,
} from '../src/store.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

let fixtureRoot: string;
let projectDir: string;
let registry: TaskRegistry;
let previousFcHome: string;

const LIVE_FIXTURE_PID = 424_242;
const DEAD_FIXTURE_PID = 2_147_483_647;

beforeAll(() => {
  previousFcHome = fcGlobalDir();
});

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-e13-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
  invalidateRunLockCache();
  registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
});

afterEach(() => {
  invalidateRunLockCache();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(previousFcHome);
});

function writeRun(
  runId: string,
  status: string,
  schedulerPid?: number,
  stages: Record<string, { status: string; retries: number }> = {},
): string {
  const path = join(runsRoot(), runId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'run.json'), JSON.stringify({
    runId,
    projectDir,
    workflowName: 'e13-fixture',
    status,
    stages,
    startedAt: '2026-08-03T16:00:00.000Z',
  }, null, 2), 'utf-8');
  if (schedulerPid !== undefined) {
    writeFileSync(join(path, 'scheduler.pid'), String(schedulerPid), 'utf-8');
    if (schedulerPid === process.pid) {
      writeSchedulerProcessIdentity(path, runId, schedulerPid);
    }
  }
  return path;
}

function admittedBrief(text: string) {
  const report = inspectBrief(text);
  return {
    brief_text: text,
    brief_admission: createBriefAdmission(report, {
      kind: 'explicit',
      source: 'cli_current_input_flag',
      at: '2026-08-03T16:00:00.000Z',
    }),
  };
}

class FakeGit implements GitAdapter {
  async findCommitByPrefix(): Promise<string | undefined> { return undefined; }
  async hasUncommittedChanges(): Promise<boolean> { return false; }
  async findCommitSince(): Promise<undefined> { return undefined; }
}

class FakeSystemd implements SupervisorBackend {
  state: UnitStatus = { kind: 'terminal', exitCode: 0 };
  isActiveCalls = 0;
  runCalls = 0;
  stopCalls = 0;
  isActiveHook?: (call: number) => Promise<void>;
  stopGate?: Promise<void>;
  stopError?: Error;
  stopStarted?: () => void;
  afterStop?: () => void;
  afterStopSettled?: () => void;

  async isActive(): Promise<UnitStatus> {
    this.isActiveCalls += 1;
    await this.isActiveHook?.(this.isActiveCalls);
    return this.state;
  }
  async runUnit(): Promise<void> {
    this.runCalls += 1;
    this.state = { kind: 'active' };
  }
  async stopUnit(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
    this.state = { kind: 'deactivating' };
    this.stopStarted?.();
    if (this.stopGate) await this.stopGate;
    this.afterStop?.();
    this.state = { kind: 'terminal', exitCode: 0 };
    this.afterStopSettled?.();
  }
  async journalTail(): Promise<string> { return ''; }
}

function completedCancellation(overrides: Partial<CancellationResult> = {}): CancellationResult {
  return {
    ok: true,
    status: 'cancelled',
    runId: 'run-one',
    observation: {
      unit: 'flowcrew-task-1.service',
      unitState: { kind: 'terminal', exitCode: 0 },
      runReadable: true,
      schedulerPid: null,
      schedulerAlive: false,
      launchInFlight: false,
    },
    message: 'confirmed',
    ...overrides,
  };
}

describe('process-authoritative project occupancy', () => {
  it('blocks cached daemon and direct scheduler admission for terminal metadata with a live scheduler', async () => {
    const ownerId = 'terminal-metadata-live-process';
    writeRun(ownerId, RUN_STATUS.FAILED, process.pid);

    const owner = findLiveRunOwnerForProject(projectDir);
    expect(owner).toMatchObject({ runId: ownerId, pid: process.pid });
    expect(activeRunsByProject().get(projectDir)).toBe(`${ownerId}, scheduler pid ${process.pid}`);
    expect(isProjectBusy(projectDir)).toBe(`${ownerId}, scheduler pid ${process.pid}`);

    const systemd = new FakeSystemd();
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git: new FakeGit(),
      cliPath: join(fixtureRoot, 'flowcrew-cli.js'),
    });
    const daemonAdmission = await orchestrator.register({
      ...admittedBrief('E13 cached daemon admission'),
      projectDir,
    });
    expect(daemonAdmission.status).toBe(TASK_STATUS.DEFERRED);
    expect(daemonAdmission.defer_reason).toContain(ownerId);
    expect(daemonAdmission.defer_reason).toContain(`scheduler pid ${process.pid}`);
    expect(systemd.runCalls).toBe(0);

    const candidateId = 'direct-scheduler-candidate';
    writeRun(candidateId, RUN_STATUS.RUNNING);
    const workflow: WorkflowConfig = {
      name: 'e13-direct-admission',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [],
    };
    const adapter = { run: vi.fn() } as unknown as Adapter;
    const directAdmission = await runWorkflow(
      workflow,
      'name: e13-direct-admission\nstages: []\n',
      projectDir,
      adapter,
      new Map(),
      undefined,
      undefined,
      candidateId,
    );
    expect(directAdmission.status).toBe(RUN_STATUS.FAILED);
    expect(directAdmission.failureReason).toContain(ownerId);
    expect(directAdmission.failureReason).toContain(`scheduler pid ${process.pid}`);
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('keeps #1817 fixed: running metadata with a dead PID is admissible', async () => {
    writeRun('running-orphan', RUN_STATUS.RUNNING, DEAD_FIXTURE_PID);

    expect(findLiveRunOwnerForProject(projectDir)).toBeNull();
    expect(isProjectBusy(projectDir)).toBeNull();
    expect(activeRunsByProject().has(projectDir)).toBe(false);

    const systemd = new FakeSystemd();
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git: new FakeGit(),
      cliPath: join(fixtureRoot, 'flowcrew-cli.js'),
    });
    const admitted = await orchestrator.register({
      ...admittedBrief('E13 dead scheduler control'),
      projectDir,
    });
    expect(admitted.status).toBe(TASK_STATUS.RUNNING);
    expect(systemd.runCalls).toBe(1);
  });

  it('does not treat an unrelated live Node process as a scheduler owner', async () => {
    const unrelatedHome = join(fixtureRoot, 'unrelated-home');
    const unrelatedFcHome = join(unrelatedHome, '.fc');
    mkdirSync(unrelatedFcHome, { recursive: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: projectDir,
      env: { ...process.env, HOME: unrelatedHome, FC_HOME: unrelatedFcHome },
      stdio: 'ignore',
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      unrelated.once('spawn', resolveSpawn);
      unrelated.once('error', rejectSpawn);
    });
    const unrelatedPid = unrelated.pid;
    if (unrelatedPid === undefined) throw new Error('unrelated Node fixture has no PID');
    try {
      writeRun('unrelated-node-owner', RUN_STATUS.FAILED, unrelatedPid);
      expect(findLiveRunOwnerForProject(projectDir)).toBeNull();
      expect(isProjectBusy(projectDir)).toBeNull();
    } finally {
      unrelated.kill('SIGTERM');
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        await new Promise<void>((resolveExit) => unrelated.once('exit', () => resolveExit()));
      }
    }
  });

  it.each(['cli.js', 'flowcrew-maintenance.js'])(
    'does not treat a live non-scheduler named %s as a project owner',
    async (scriptName) => {
      const scriptPath = join(fixtureRoot, scriptName);
      const probeHome = join(fixtureRoot, `${scriptName}-home`);
      const probeFcHome = join(probeHome, '.fc');
      mkdirSync(probeFcHome, { recursive: true });
      writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n', 'utf-8');
      const unrelated = spawn(process.execPath, [scriptPath], {
        cwd: projectDir,
        env: { ...process.env, HOME: probeHome, FC_HOME: probeFcHome },
        stdio: 'ignore',
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        unrelated.once('spawn', resolveSpawn);
        unrelated.once('error', rejectSpawn);
      });
      const unrelatedPid = unrelated.pid;
      if (unrelatedPid === undefined) throw new Error(`${scriptName} fixture has no PID`);
      try {
        writeRun(`unrelated-${scriptName}-owner`, RUN_STATUS.FAILED, unrelatedPid);
        expect(findLiveRunOwnerForProject(projectDir)).toBeNull();
        expect(isProjectBusy(projectDir)).toBeNull();
      } finally {
        unrelated.kill('SIGTERM');
        if (unrelated.exitCode === null && unrelated.signalCode === null) {
          await new Promise<void>((resolveExit) => unrelated.once('exit', () => resolveExit()));
        }
      }
    },
  );

  it('never selects an unrelated cli.js PID as the registered-task SIGTERM fallback', async () => {
    const runId = 'unrelated-cli-signal-target';
    const scriptPath = join(fixtureRoot, 'cli.js');
    const probeHome = join(fixtureRoot, 'cli-signal-home');
    const probeFcHome = join(probeHome, '.fc');
    mkdirSync(probeFcHome, { recursive: true });
    writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n', 'utf-8');
    const unrelated = spawn(process.execPath, [scriptPath], {
      cwd: projectDir,
      env: { ...process.env, HOME: probeHome, FC_HOME: probeFcHome },
      stdio: 'ignore',
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      unrelated.once('spawn', resolveSpawn);
      unrelated.once('error', rejectSpawn);
    });
    const unrelatedPid = unrelated.pid;
    if (unrelatedPid === undefined) throw new Error('cli.js signal fixture has no PID');
    try {
      writeRun(runId, RUN_STATUS.RUNNING, unrelatedPid);
      const task = registry.create({
        brief_text: 'unrelated cli signal fixture',
        projectDir,
        run_id: runId,
        status: TASK_STATUS.RUNNING,
        systemd_unit: 'flowcrew-e13-unrelated-cli.service',
      });
      const systemd = new FakeSystemd();
      systemd.state = { kind: 'terminal', exitCode: 1 };
      systemd.stopError = new Error('systemctl stop failed');
      const sentSignals: string[] = [];
      const coordinator = new RunCancellationCoordinator({
        registry,
        units: systemd,
        timeoutMs: 0,
        signalGraceMs: 0,
        signalScheduler: (pid, signal) => { sentSignals.push(`${pid}:${signal}`); },
      });

      const result = await coordinator.cancelTask(task.id);

      expect(result).toMatchObject({ ok: true, status: 'cancelled' });
      expect(sentSignals).toEqual([]);
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
    } finally {
      unrelated.kill('SIGTERM');
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        await new Promise<void>((resolveExit) => unrelated.once('exit', () => resolveExit()));
      }
    }
  });

  it('rejects a scheduler.pid marker with a numeric prefix and trailing data', () => {
    const path = writeRun('malformed-pid-owner', RUN_STATUS.FAILED);
    writeFileSync(join(path, 'scheduler.pid'), `${process.pid}trailing-data`, 'utf-8');

    expect(findLiveRunOwnerForProject(projectDir)).toBeNull();
    expect(isProjectBusy(projectDir)).toBeNull();
  });

  it('binds a live PID to the run whose scheduler identity claimed it', () => {
    const ownerPath = writeRun('identity-owner', RUN_STATUS.FAILED, process.pid);
    const recycledPath = writeRun('identity-recycled-marker', RUN_STATUS.FAILED);
    writeFileSync(join(recycledPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeFileSync(
      join(recycledPath, 'scheduler.identity.json'),
      readFileSync(join(ownerPath, 'scheduler.identity.json'), 'utf-8'),
      'utf-8',
    );

    expect(isLiveFlowcrewSchedulerForRun(process.pid, 'identity-owner', ownerPath)).toBe(true);
    expect(isLiveFlowcrewSchedulerForRun(process.pid, 'identity-recycled-marker', recycledPath)).toBe(false);
    expect(findLiveRunOwnerForProject(projectDir)).toMatchObject({
      runId: 'identity-owner',
      pid: process.pid,
    });
  });

  it('preserves parked release semantics and guards only its live resume hand-off', () => {
    const path = writeRun('parked-owner', RUN_STATUS.PARKED, DEAD_FIXTURE_PID);
    expect(isProjectBusy(projectDir)).toBeNull();

    writeFileSync(join(path, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(path, 'parked-owner');
    invalidateRunLockCache();
    expect(isProjectBusy(projectDir)).toBe(`parked-owner, scheduler pid ${process.pid}`);
  });
});

describe('systemd confirmation truth', () => {
  it('keeps cancellation observable when systemctl fails without a trustworthy state', async () => {
    const runId = 'unverified-systemd-state';
    const unit = 'flowcrew-e13-unverified.service';
    writeRun(runId, RUN_STATUS.RUNNING);
    const task = registry.create({
      brief_text: 'unverified systemd fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.RUNNING,
      systemd_unit: unit,
    });
    const fakeBin = join(fixtureRoot, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 1\n', 'utf-8');
    chmodSync(fakeSystemctl, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${priorPath ?? ''}`;
    try {
      const systemd = new NodeSystemd(registry.baseDir);
      await expect(systemd.isActive(unit)).resolves.toEqual({
        kind: 'unobservable',
        reason: 'systemctl probe failed',
      });
      const coordinator = new RunCancellationCoordinator({
        registry,
        units: systemd,
        timeoutMs: 0,
        signalGraceMs: 0,
      });

      const result = await coordinator.cancelTask(task.id);

      expect(result).toMatchObject({
        ok: false,
        status: 'cancelling',
        observation: { unitState: { kind: 'unobservable', reason: 'systemctl probe failed' } },
      });
      expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLING);
      expect(readRunState(projectDir, runId).status).toBe(RUN_STATUS.RUNNING);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it('does not let a stale inactive fallback record confirm an unobserved unit stop', async () => {
    const runId = 'stale-systemd-fallback-state';
    const unit = 'flowcrew-e13-stale-fallback.service';
    writeRun(runId, RUN_STATUS.RUNNING);
    const task = registry.create({
      brief_text: 'stale systemd fallback fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.RUNNING,
      systemd_unit: unit,
    });
    const fakeBin = join(fixtureRoot, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 1\n', 'utf-8');
    chmodSync(fakeSystemctl, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${priorPath ?? ''}`;
    try {
      const systemd = new NodeSystemd(registry.baseDir);
      writeFileSync(
        join(registry.baseDir, 'systemd-fallback', `${unit}.json`),
        JSON.stringify({ state: 'inactive' }),
        'utf-8',
      );
      await expect(systemd.isActive(unit)).resolves.toEqual({
        kind: 'unobservable',
        reason: 'systemctl probe failed',
      });
      const coordinator = new RunCancellationCoordinator({
        registry,
        units: systemd,
        timeoutMs: 0,
        signalGraceMs: 0,
      });

      const result = await coordinator.cancelTask(task.id);

      expect(result).toMatchObject({
        ok: false,
        status: 'cancelling',
        observation: { unitState: { kind: 'unobservable', reason: 'systemctl probe failed' } },
      });
      expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLING);
      expect(readRunState(projectDir, runId).status).toBe(RUN_STATUS.RUNNING);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
});

describe('cancel-and-confirm coordinator', () => {
  it('stops execution but preserves an unrecognized archived lifecycle value explicitly', async () => {
    const runId = 'cancel-future-status';
    writeRun(runId, 'future_archived_state');
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: new FakeSystemd(),
      timeoutMs: 0,
      signalGraceMs: 0,
    });

    const result = await coordinator.cancelRun(runId);

    expect(result).toMatchObject({
      ok: true,
      status: 'cancelled',
      runId,
      preservedRunStatus: 'future_archived_state',
    });
    expect(result.message).toContain('run lifecycle was preserved because Unrecognized archived run status');
    expect(readRunState(projectDir, runId).status).toBe('future_archived_state');
  });

  it('exposes before/during/after truth and joins concurrent task/run callers', async () => {
    const runId = 'cancel-three-barriers';
    writeRun(runId, RUN_STATUS.RUNNING, LIVE_FIXTURE_PID, {
      work: { status: STAGE_STATUS.RUNNING, retries: 0 },
      later: { status: STAGE_STATUS.PENDING, retries: 0 },
    });
    const task = registry.create({
      brief_text: 'cancel fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.RUNNING,
      systemd_unit: 'flowcrew-e13-gated.service',
    });
    const systemd = new FakeSystemd();
    systemd.state = { kind: 'active' };
    let releaseStop!: () => void;
    systemd.stopGate = new Promise<void>((resolveStop) => { releaseStop = resolveStop; });
    let reportStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolveStopStarted) => { reportStopStarted = resolveStopStarted; });
    systemd.stopStarted = reportStopStarted;
    let schedulerAlive = true;
    systemd.afterStop = () => { schedulerAlive = false; };
    const sentSignals: string[] = [];
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: systemd,
      timeoutMs: 1_000,
      pollMs: 5,
      signalGraceMs: 5,
      isSchedulerPidAlive: (pid) => pid === LIVE_FIXTURE_PID && schedulerAlive,
      canSignalScheduler: () => true,
      signalScheduler: (pid, signal) => { sentSignals.push(`${pid}:${signal}`); },
    });

    expect({
      process: schedulerAlive,
      unit: systemd.state,
      registry: registry.get(task.id)?.status,
      run: readRunState(projectDir, runId).status,
    }).toEqual({ process: true, unit: { kind: 'active' }, registry: 'running', run: 'running' });

    const byTask = coordinator.cancelTask(task.id);
    const byRun = coordinator.cancelRun(runId);
    expect(byRun).toBe(byTask);
    await stopStarted;
    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLING);
    expect({
      process: schedulerAlive,
      unit: systemd.state,
      registry: registry.get(task.id)?.status,
      run: readRunState(projectDir, runId).status,
    }).toEqual({ process: true, unit: { kind: 'deactivating' }, registry: 'cancelling', run: 'running' });

    releaseStop();
    const result = await byTask;
    const state = readRunState(projectDir, runId);
    expect(result).toMatchObject({ ok: true, status: 'cancelled', taskId: task.id, runId });
    expect(systemd.stopCalls).toBe(1);
    expect(sentSignals).toEqual([]);
    expect({
      process: schedulerAlive,
      unit: systemd.state,
      registry: registry.get(task.id)?.status,
      run: state.status,
      reason: state.failureReason,
    }).toEqual({
      process: false,
      unit: { kind: 'terminal', exitCode: 0 },
      registry: 'cancelled',
      run: 'stopped',
      reason: 'Cancelled by user',
    });
    expect(state.stages.work.status).toBe(STAGE_STATUS.FAILED);
    expect(state.stages.later.status).toBe(STAGE_STATUS.SKIPPED);
  });

  it('times out without writing false terminal state and leaves catch-up-visible evidence', async () => {
    const runId = 'cancel-timeout';
    writeRun(runId, RUN_STATUS.RUNNING, LIVE_FIXTURE_PID);
    const task = registry.create({
      brief_text: 'timeout fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.RUNNING,
      systemd_unit: 'flowcrew-e13-timeout.service',
    });
    const systemd = new FakeSystemd();
    systemd.state = { kind: 'active' };
    systemd.stopGate = new Promise<void>(() => {});
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: systemd,
      timeoutMs: 30,
      pollMs: 5,
      signalGraceMs: 1,
      isSchedulerPidAlive: () => true,
      canSignalScheduler: () => true,
      signalScheduler: () => undefined,
    });

    const result = await coordinator.cancelTask(task.id);

    expect(result).toMatchObject({ ok: false, status: 'cancelling' });
    expect(result.message).toContain('unit=deactivating');
    expect(result.message).toContain(`scheduler pid=${LIVE_FIXTURE_PID} alive=true`);
    expect(registry.get(task.id)).toMatchObject({ status: TASK_STATUS.CANCELLING });
    expect(readRunState(projectDir, runId)).toMatchObject({ status: RUN_STATUS.RUNNING });
    expect(registry.readRecentTicks(task.id).at(-1)).toContain('status=cancelling');
  });

  it('cancels an unregistered run through the same coordinator when its unit is known', async () => {
    const runId = 'campaign-unregistered-run';
    writeRun(runId, RUN_STATUS.RUNNING, LIVE_FIXTURE_PID);
    const systemd = new FakeSystemd();
    systemd.state = { kind: 'active' };
    systemd.stopError = new Error('systemctl stop failed');
    let schedulerAlive = true;
    const sentSignals: string[] = [];
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: systemd,
      signalGraceMs: 0,
      isSchedulerPidAlive: () => schedulerAlive,
      canSignalScheduler: () => true,
      signalScheduler: (pid, signal) => {
        sentSignals.push(`${pid}:${signal}`);
        schedulerAlive = false;
        systemd.state = { kind: 'terminal', exitCode: 1 };
      },
    });

    const result = await coordinator.cancelRun(runId, 'flowcrew-campaign-run.service');

    expect(result).toMatchObject({ ok: true, status: 'cancelled', runId });
    expect(systemd.stopCalls).toBe(1);
    expect(sentSignals).toEqual([`${LIVE_FIXTURE_PID}:SIGTERM`]);
    expect(readRunState(projectDir, runId)).toMatchObject({
      status: RUN_STATUS.STOPPED,
      failureReason: 'Cancelled by user',
    });
  });

  it('re-stops a unit that appears after cancellation raced an in-flight launch', async () => {
    const runId = 'cancel-launch-race';
    expect(claimLaunchIntent(projectDir, runId).claimed).toBe(true);
    const task = registry.create({
      brief_text: 'launch race fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.RUNNING,
      systemd_unit: 'flowcrew-e13-launch-race.service',
    });
    const systemd = new FakeSystemd();
    let launchInFlight = true;
    let schedulerAlive = true;
    systemd.afterStop = () => {
      if (!launchInFlight) {
        schedulerAlive = false;
        releaseLaunchIntent(projectDir, runId);
      }
    };
    const launchSettled = new Promise<void>((resolveLaunch) => {
      systemd.afterStopSettled = () => {
        if (!launchInFlight) return;
        writeRun(runId, RUN_STATUS.RUNNING, LIVE_FIXTURE_PID);
        launchInFlight = false;
        systemd.state = { kind: 'active' };
        resolveLaunch();
      };
    });
    const coordinator = new RunCancellationCoordinator({
      registry,
      units: systemd,
      timeoutMs: 250,
      pollMs: 5,
      signalGraceMs: 0,
      isLaunchInFlight: () => launchInFlight,
      isSchedulerPidAlive: () => schedulerAlive,
    });

    const result = await coordinator.cancelTask(task.id);
    await launchSettled;

    expect(result).toMatchObject({ ok: true, status: 'cancelled' });
    expect(systemd.stopCalls).toBe(2);
    expect(systemd.state).toEqual({ kind: 'terminal', exitCode: 0 });
    expect(readRunState(projectDir, runId).status).toBe(RUN_STATUS.STOPPED);
  });

  it('lets the daemon sweep finish a cancellation interrupted after the durable transition', async () => {
    const runId = 'cancel-daemon-catch-up';
    writeRun(runId, RUN_STATUS.RUNNING);
    const task = registry.create({
      brief_text: 'daemon catch-up fixture',
      projectDir,
      run_id: runId,
      status: TASK_STATUS.CANCELLING,
      systemd_unit: 'flowcrew-e13-catch-up.service',
    });
    const systemd = new FakeSystemd();
    systemd.state = { kind: 'active' };
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git: new FakeGit(),
      cliPath: join(fixtureRoot, 'flowcrew-cli.js'),
      isProjectBusy: () => null,
      cancellation: { signalGraceMs: 0, timeoutMs: 250, pollMs: 5 },
    });

    await orchestrator.tickOnce();

    expect(systemd.stopCalls).toBe(1);
    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLED);
    expect(readRunState(projectDir, runId).status).toBe(RUN_STATUS.STOPPED);
  });

  it('does not let a stale queued-task probe relaunch after cancellation completes', async () => {
    const task = registry.create({
      ...admittedBrief('cancel while queued admission is probing the unit'),
      projectDir,
      status: TASK_STATUS.DEFERRED,
    });
    const systemd = new FakeSystemd();
    let releaseFirstProbe!: () => void;
    let firstProbeStarted!: () => void;
    const firstProbe = new Promise<void>((resolveProbe) => { firstProbeStarted = resolveProbe; });
    const probeGate = new Promise<void>((resolveProbe) => { releaseFirstProbe = resolveProbe; });
    systemd.isActiveHook = async (call) => {
      if (call !== 1) return;
      firstProbeStarted();
      await probeGate;
    };
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git: new FakeGit(),
      cliPath: join(fixtureRoot, 'flowcrew-cli.js'),
      isProjectBusy: () => null,
      cancellation: { signalGraceMs: 0, timeoutMs: 250, pollMs: 5 },
    });

    const sweep = orchestrator.tickOnce();
    await firstProbe;
    await orchestrator.cancel(task.id);
    releaseFirstProbe();
    await sweep;

    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLED);
    expect(systemd.runCalls).toBe(0);
    expect(registry.readRecentTicks(task.id).at(-1)).toContain('status=cancelled');
  });
});

describe('daemon cancellation convergence', () => {
  it('routes numeric CLI RPC and run-id Dashboard RPC exactly once to orchestrator methods', async () => {
    const cancel = vi.fn(async () => completedCancellation({ taskId: 7 }));
    const cancelRun = vi.fn(async () => completedCancellation({ runId: 'dashboard-run' }));
    const control = { cancel, cancelRun };

    await expect(handleDaemonCancellationRequest(control, { cmd: 'cancel', id: 7 }))
      .resolves.toMatchObject({ ok: true, taskId: 7 });
    await expect(handleDaemonCancellationRequest(control, { cmd: 'cancel-run', runId: 'dashboard-run' }))
      .resolves.toMatchObject({ ok: true, runId: 'dashboard-run' });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(7);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledWith('dashboard-run', undefined);
  });

  it('does not let numeric CLI cancellation report success while stop remains pending', async () => {
    const pending = completedCancellation({
      ok: false,
      status: 'cancelling',
      message: 'unit still deactivating',
    });
    const control = {
      cancel: vi.fn(async () => pending),
      cancelRun: vi.fn(async () => pending),
    };

    await expect(handleDaemonCancellationRequest(control, { cmd: 'cancel', id: 9 }))
      .rejects.toThrow('Cancellation still in progress');
  });
});
