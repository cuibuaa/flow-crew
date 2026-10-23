import './test-support/policy-runtime.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { cmdTask } from '../src/cli-task.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { createDaemonReconciler } from '../src/daemon-reconciliation.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { inspectRunScheduler, processStartToken, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { readHostBootId } from '../src/restart-recovery.js';
import {
  atomicWriteJson, observePortableUnit, supervisionPaths, SUPERVISION_PROTOCOL_VERSION,
  type SupervisorBackend,
} from '../src/supervision.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

const DEAD_PID = 2_147_483_647;
let root: string, project: string, previousStore: string, runId: string, directory: string, registry: TaskRegistry;
const unit = 'lost-controller.service';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-dead-shim-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  registry = new TaskRegistry({ baseDir: join(root, 'registry') });
  runId = createRun(project, 'fixture', 'name: fixture\nstages: [{id: work, role: coder, scope: [], artifact_contract: {version: 1, produces: [], reads: []}}]\n', ['work']).runId;
  directory = runDir(project, runId);
  writeFileSync(join(directory, 'scheduler.pid'), String(DEAD_PID));
  atomicWriteJson(supervisionPaths(registry.baseDir, unit).running, {
    version: SUPERVISION_PROTOCOL_VERSION,
    shimPid: DEAD_PID, shimCommand: 'lost controller', agentPid: DEAD_PID,
    command: 'owned execution', startedAt: new Date().toISOString(),
  });
  updateRunState(project, runId, state => {
    state.status = 'parked';
    state.recovery = { kind: 'resumable', reason: 'HOST_RESTART_RESUMABLE', at: new Date().toISOString(), interruptedStages: [] };
    state.engineCheckpoint = {
      version: 2, runId, projectDir: project, bootId: readHostBootId(),
      generation: 'fixture-generation', pid: DEAD_PID, processes: [], at: new Date().toISOString(),
    };
    state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4;
  });
});

afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function backend(): SupervisorBackend {
  return {
    async isActive() { return observePortableUnit(registry.baseDir, unit).status; },
    async stopUnit() {},
    async runUnit() { throw new Error('unexpected automatic launch'); },
    async journalTail() { return ''; },
  };
}

function cancellation(units = backend(), signalScheduler = vi.fn()) {
  return new RunCancellationCoordinator({ registry, units, timeoutMs: 0, signalGraceMs: 0, signalScheduler });
}

describe('lost shim process proof and lifecycle settlement', () => {
  it.each(['missing', 'truncated', 'malformed'])('closes operator cancellation with %s acknowledged history', async damage => {
    updateRunState(project, runId, state => {
      state.status = 'running';
      state.retiredStageUsage = [{ stageId: 'earlier', iteration: 1, status: { status: 'complete', retries: 0 } }];
    });
    const projection = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    const history = join(directory, projection.stateFormat.history.path);
    if (damage === 'missing') rmSync(history);
    else writeFileSync(history, damage === 'truncated' ? '' : 'x'.repeat(projection.stateFormat.history.committedBytes));
    const damagedBytes = damage === 'missing' ? undefined : readFileSync(history);
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });
    const control = cancellation();
    const io = new PassThrough();
    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io as unknown as NodeJS.WriteStream, stderr: io as unknown as NodeJS.WriteStream,
      cancellationClient: {
        sendRequest: async request => request.cmd === 'show' ? { task, recent_ticks: [] } : control.cancelTask(task.id),
        localControl: { cancel: id => control.cancelTask(id), cancelRun: id => control.cancelRun(id) },
      },
    });
    expect(code, io.read()?.toString()).toBe(0);
    const settled = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    expect(settled).toMatchObject({ status: 'cancelled', failureReason: 'Cancelled by user', completedAt: expect.any(String) });
    expect(settled.stateFormat.history).toEqual(projection.stateFormat.history);
    if (damagedBytes) expect(readFileSync(history)).toEqual(damagedBytes);
    else expect(() => readFileSync(history)).toThrow();
    expect(registry.get(task.id)?.status).toBe('cancelled');
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
    expect(summary).toContain('Status: **cancelled**');
    expect(summary).toContain('Historical evidence was not loaded');
    expect(existsSync(join(directory, 'progress.md'))).toBe(false);
    expect(await control.cancelRun(runId)).toMatchObject({ ok: true, status: 'cancelled' });
  });

  it.each(['absent', 'malformed', 'partial'])('closes task cancellation with an %s run projection', async damage => {
    if (damage === 'absent') rmSync(join(directory, 'run.json'));
    else writeFileSync(join(directory, 'run.json'), damage === 'malformed' ? '{invalid' : JSON.stringify({ runId, projectDir: project, status: 'running' }));
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });
    const signal = vi.fn();
    const control = cancellation(backend(), signal);
    const io = new PassThrough();
    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io as unknown as NodeJS.WriteStream, stderr: io as unknown as NodeJS.WriteStream,
      cancellationClient: {
        sendRequest: async request => {
          expect(request).toEqual({ cmd: 'cancel', id: task.id });
          return control.cancelTask(task.id);
        },
        localControl: { cancel: id => control.cancelTask(id), cancelRun: id => control.cancelRun(id) },
      },
    });
    expect(code, io.read()?.toString()).toBe(0);
    expect(registry.get(task.id)?.status).toBe('cancelled');
    if (damage === 'partial') expect(registry.get(task.id)?.notes).toContain('run settlement:');
    expect(signal).not.toHaveBeenCalled();
  });

  it.each(['projection', 'binding'])('closes the registered task without control over a corrupt run %s', async damage => {
    if (damage === 'projection') {
      const state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...state, runId: 'unbound-projection' }));
    }
    const original = readFileSync(join(directory, 'run.json'));
    const task = registry.create({ projectDir: project, run_id: damage === 'binding' ? 'invalid/binding' : runId, status: 'running', systemd_unit: unit });
    const signal = vi.fn();
    const control = cancellation(backend(), signal);
    const remote = vi.fn(async () => control.cancelTask(task.id));
    const io = new PassThrough();
    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io as unknown as NodeJS.WriteStream, stderr: io as unknown as NodeJS.WriteStream,
      cancellationClient: { sendRequest: remote },
    });
    expect(code, io.read()?.toString()).toBe(0);
    expect(await remote.mock.results[0].value).toMatchObject({ ok: true, observation: { runReadable: false } });
    expect(registry.get(task.id)?.status).toBe('cancelled');
    expect(readFileSync(join(directory, 'run.json'))).toEqual(original);
    expect(signal).not.toHaveBeenCalled();
  });

  it('closes malformed checkpoint ownership without granting signal authority', async () => {
    updateRunState(project, runId, state => { state.engineCheckpoint!.processes = [{ pid: -1 }]; });
    const signal = vi.fn();
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });
    const result = await cancellation(backend(), signal).cancelTask(task.id);
    expect(result).toMatchObject({ ok: true, status: 'cancelled', observation: { commandFateKnown: false } });
    expect(readRunState(project, runId).status).toBe('cancelled');
    expect(registry.get(task.id)?.status).toBe('cancelled');
    expect(signal).not.toHaveBeenCalled();
  });

  it('accepts a confirmed operator cancellation after the shim lost its exit verdict', async () => {
    const task = registry.create({ projectDir: project, run_id: runId, status: 'deferred', defer_kind: 'retry', not_before: new Date().toISOString(), systemd_unit: unit });
    const control = cancellation();
    const fallback = vi.fn(async () => { throw new Error('confirmed cancellation must not be repeated'); });
    const io = new PassThrough();
    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io as unknown as NodeJS.WriteStream, stderr: io as unknown as NodeJS.WriteStream,
      cancellationClient: {
        sendRequest: async request => request.cmd === 'show' ? { task, recent_ticks: [] } : control.cancelTask(task.id),
        localControl: { cancel: fallback, cancelRun: fallback },
      },
    });
    expect(code, io.read()?.toString()).toBe(0);
    expect(fallback).not.toHaveBeenCalled();
    expect(registry.get(task.id)?.status).toBe('cancelled');
    expect(registry.get(task.id)?.not_before).toBeUndefined();
    expect(registry.get(task.id)?.defer_kind).toBeUndefined();
    expect(readRunState(project, runId).status).toBe('cancelled');
  });

  it('resumes the same recovered run after manual retry of a terminal-unknown unit', async () => {
    const brief = 'Resume the interrupted execution';
    const admission = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
    writeFileSync(join(directory, 'task_brief.md'), brief);
    updateRunState(project, runId, state => {
      state.status = 'running';
      delete state.recovery;
      state.engineCheckpoint!.bootId = 'previous-boot';
      state.briefAdmission = admission;
    });
    const warn = vi.fn();
    createDaemonReconciler(registry, warn)();
    expect(warn).not.toHaveBeenCalled();
    expect(readRunState(project, runId)).toMatchObject({
      status: 'parked', recovery: { kind: 'resumable', reason: expect.stringContaining('HOST_RESTART_RESUMABLE') },
    });
    const task = registry.create({
      name: brief, brief_text: brief, brief_admission: admission,
      projectDir: project, run_id: runId, status: 'stuck', systemd_unit: unit,
    });
    let clock = Date.now();
    const units = backend();
    const launch = vi.fn<SupervisorBackend['runUnit']>(async () => {});
    units.runUnit = launch;
    units.isActive = async observedUnit => observedUnit === unit
      ? observePortableUnit(registry.baseDir, unit).status
      : { kind: 'active' };
    const orchestrator = new Orchestrator({ registry, systemd: units, git: {} as never, now: () => new Date(clock) });
    expect(await units.isActive(unit)).toEqual({ kind: 'terminal-unknown', reason: 'shim-died-without-status' });

    expect(await orchestrator.retry(task.id)).toMatchObject({ status: 'deferred', defer_kind: 'retry', run_id: runId, attempt: 1 });
    await orchestrator.tickOnce();
    expect(launch).not.toHaveBeenCalled();
    clock = Date.parse(registry.get(task.id)!.not_before!) + 1;
    await orchestrator.tickOnce();

    expect(launch).toHaveBeenCalledExactlyOnceWith({
      unit: expect.not.stringMatching(unit), workingDirectory: project,
      command: expect.stringContaining(`'--existing-run-id' '${runId}'`),
    });
    expect(registry.get(task.id)).toMatchObject({ status: 'running', run_id: runId, attempt: 2 });
    expect(readRunState(project, runId)).toMatchObject({ status: 'parked', currentIteration: 2, maxIterations: 3, maxRetries: 4 });
    await orchestrator.tickOnce();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'stuck'] as const)('cancels the parked run with a %s task after exact processes died', async status => {
    const task = registry.create({ name: 'Interrupted execution', projectDir: project, run_id: runId, status, systemd_unit: unit });
    expect(inspectRunScheduler(runId, directory)).toEqual({ kind: 'dead', pid: DEAD_PID });
    expect(observePortableUnit(registry.baseDir, unit).status).toEqual({ kind: 'terminal-unknown', reason: 'shim-died-without-status' });

    const result = await cancellation().cancelTask(task.id);

    expect(result.ok).toBe(true);
    expect(readRunState(project, runId)).toMatchObject({
      status: 'cancelled', failureReason: 'Cancelled by user', completedAt: expect.any(String),
      currentIteration: 2, maxIterations: 3, maxRetries: 4,
    });
    expect(registry.get(task.id)?.status).toBe(status === 'running' ? 'cancelled' : 'stuck');
  });

  it.each(['running', 'manual-retry'] as const)('refuses a parked run without resume authority at %s', async path => {
    updateRunState(project, runId, state => {
      delete state.recovery;
      state.failureReason = 'RECOVERY_FATE_UNKNOWN: interrupted process fate is unproven';
    });
    const before = readFileSync(join(directory, 'run.json'), 'utf8');
    const task = registry.create({ projectDir: project, run_id: runId, status: path === 'running' ? 'running' : 'stuck', systemd_unit: unit });
    let clock = Date.now();
    const units = backend();
    const launch = vi.spyOn(units, 'runUnit');
    const orchestrator = new Orchestrator({ registry, systemd: units, git: {} as never, now: () => new Date(clock) });
    if (path === 'manual-retry') {
      expect(await orchestrator.retry(task.id)).toMatchObject({ status: 'deferred', defer_kind: 'retry', run_id: runId, attempt: 1 });
      clock = Date.parse(registry.get(task.id)!.not_before!) + 1;
    }

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'stuck', attempt: 1, run_id: runId });
    expect(registry.get(task.id)?.notes).toContain('no pending approval and no proven resume authority');
    expect(registry.get(task.id)?.notes).toContain('RECOVERY_FATE_UNKNOWN');
    clock += 120_000;
    await orchestrator.tickOnce();
    expect(registry.get(task.id)?.status).toBe('stuck');
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(before);
    expect(launch).not.toHaveBeenCalled();
  });

  it('reconciles a terminal bound run despite a lost shim verdict', async () => {
    updateRunState(project, runId, state => { state.status = 'failed'; });
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });
    const units = backend();
    const launch = vi.spyOn(units, 'runUnit');
    const orchestrator = new Orchestrator({ registry, systemd: units, git: {} as never });

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'failed', run_id: runId, attempt: 1 });
    expect(readRunState(project, runId).status).toBe('failed');
    expect(registry.get(task.id)?.notes).toBe(`bound run ${runId} ended failed`);
    expect(launch).not.toHaveBeenCalled();
  });

  it('reconciles stale running state before queuing an authorized same-run retry', async () => {
    updateRunState(project, runId, state => { state.status = 'running'; delete state.recovery; });
    const task = registry.create({ name: 'Interrupted execution', projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });
    const units = backend();
    const launch = vi.spyOn(units, 'runUnit');
    const orchestrator = new Orchestrator({ registry, systemd: units, git: {} as never });

    await orchestrator.tickOnce();

    expect(readRunState(project, runId)).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' }, currentIteration: 2 });
    expect(registry.get(task.id)).toMatchObject({ status: 'deferred', defer_kind: 'retry', attempt: 1, run_id: runId });
    expect(registry.get(task.id)?.defer_reason).toContain('resuming that exact run');
    expect(launch).not.toHaveBeenCalled();
  });

  it('closes control state without signalling a surviving unbound child after its shim died', async () => {
    const paths = supervisionPaths(registry.baseDir, unit);
    const record = JSON.parse(readFileSync(paths.running, 'utf8'));
    atomicWriteJson(paths.running, { ...record, agentPid: process.pid, agentToken: processStartToken(process.pid) });
    const signal = vi.fn();
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });

    expect(observePortableUnit(registry.baseDir, unit).status.kind).toBe('unobservable');
    const result = await cancellation(backend(), signal).cancelTask(task.id);

    expect(result).toMatchObject({ ok: true, status: 'cancelled', observation: { unitState: { kind: 'unobservable' } } });
    expect(readRunState(project, runId).status).toBe('cancelled');
    expect(signal).not.toHaveBeenCalled();
  });

  it('closes control state while reporting unreadable process ownership', async () => {
    writeFileSync(supervisionPaths(registry.baseDir, unit).running, '{bad}');
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });

    expect(observePortableUnit(registry.baseDir, unit).status.kind).toBe('unobservable');
    expect(await cancellation().cancelTask(task.id)).toMatchObject({ ok: true, status: 'cancelled', observation: { unitState: { kind: 'unobservable' } } });
    expect(readRunState(project, runId).status).toBe('cancelled');
  });

  it('fences a live owned scheduler and attempts its stop despite a dead shim', async () => {
    writeFileSync(join(directory, 'scheduler.pid'), String(process.pid));
    writeSchedulerProcessIdentity(directory, runId);
    const signal = vi.fn();
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });

    const result = await cancellation(backend(), signal).cancelTask(task.id);

    expect(result).toMatchObject({ ok: true, status: 'cancelled', observation: { schedulerAlive: true } });
    expect(readRunState(project, runId).status).toBe('cancelled');
    expect(signal).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('settles after scheduler PID reuse without signalling the unrelated process', async () => {
    writeFileSync(join(directory, 'scheduler.pid'), String(process.pid));
    writeSchedulerProcessIdentity(directory, runId);
    const identityPath = join(directory, 'scheduler.identity.json');
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    identity.startToken.value = identity.startToken.kind === 'linux'
      ? String(BigInt(identity.startToken.value) + 1n) : `${identity.startToken.value} previous-process`;
    writeFileSync(identityPath, JSON.stringify(identity));
    const signal = vi.fn();
    const task = registry.create({ projectDir: project, run_id: runId, status: 'running', systemd_unit: unit });

    expect(inspectRunScheduler(runId, directory)).toEqual({ kind: 'reused', pid: process.pid });
    expect(await cancellation(backend(), signal).cancelTask(task.id)).toMatchObject({ ok: true, status: 'cancelled' });
    expect(readRunState(project, runId).status).toBe('cancelled');
    expect(signal).not.toHaveBeenCalled();
  });
});
