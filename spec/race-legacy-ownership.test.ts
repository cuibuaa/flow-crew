import './test-support/policy-runtime.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCancellationResult } from '../src/cancellation-client.js';
import { processGroupIsAlive } from '../src/process-liveness.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { captureEngineCheckpoint, reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { processStartToken } from '../src/run-lock.js';
import { RecordedStageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { beginStageAttempt, createRun, fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import type { SupervisorBackend } from '../src/supervision.js';
import { TaskRegistry } from '../src/task-registry.js';

let directory: string, project: string, previous: string, child: ChildProcess | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flowcrew-legacy-race-'));
  project = join(directory, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(directory, 'store'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child!.once('close', () => resolve()));
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* owned group closed */ }
    await closed;
  }
  child = undefined;
  setFcGlobalDir(previous); rmSync(directory, { recursive: true, force: true });
});

async function interruptedLegacy(race: boolean, previousBoot = false) {
  const marker = join(directory, 'writer-ready');
  child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "ready");setInterval(()=>{},1000)', marker],
    { detached: true, stdio: 'ignore', cwd: project,
      env: { ...process.env, HOME: directory, FC_HOME: fcGlobalDir() } });
  for (let count = 0; count < 500 && !existsSync(marker); count++) await delay(10);
  expect(existsSync(marker)).toBe(true);
  const contract = { version: 1, produces: [], reads: [], replays: [] };
  const stages = [RecordedStageConfigSchema.parse({ id: 'work', role: 'coder', race, scope: [], artifact_contract: contract }),
    RecordedStageConfigSchema.parse({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [], artifact_contract: contract })];
  const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']);
  beginStageAttempt(project, created.runId, 'work', 0);
  updateRunState(project, created.runId, state => {
    recordAdmittedPlan(state, stages, created.runDirPath, 'Fixture admission');
    state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), version: 1, pid: 2147483647,
      processStart: undefined, processes: previousBoot ? [{ pid: child!.pid!, processStart: processStartToken(child!.pid!) }] : [],
      ...(previousBoot ? { bootId: 'fixture-previous-boot' } : {}) };
  });
  const units: SupervisorBackend = { isActive: async () => ({ kind: 'absent' }), runUnit: async () => {}, stopUnit: async () => {}, journalTail: async () => '' };
  const control = new RunCancellationCoordinator({ registry: new TaskRegistry({ baseDir: join(directory, 'registry') }), units,
    runsDir: join(fcGlobalDir(), 'runs'), timeoutMs: 0, pollMs: 10, signalGraceMs: 0 });
  return { runId: created.runId, control };
}

describe('legacy checkpoint ownership across an engine upgrade', () => {
  it('publishes the stronger enclosing ownership contract in new checkpoints', () => {
    const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
    expect(captureEngineCheckpoint(project, runId).version).toBe(2);
  });

  it.skipIf(process.platform !== 'linux')('refuses same-boot race recovery when the old parent omitted candidate consumers', async () => {
    const { runId } = await interruptedLegacy(true);
    const recovered = reconcileHostInterruptedRun(project, runId);
    expect(recovered).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
    expect(recovered.failureReason).toContain('RECOVERY_FATE_UNKNOWN');
    expect(processGroupIsAlive(child!.pid!)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('closes legacy race cancellation while retaining unknown command fate and refusing unsafe signals', async () => {
    const { runId, control } = await interruptedLegacy(true);
    const signals = vi.spyOn(process, 'kill');
    expect(await control.cancelRun(runId)).toMatchObject({ ok: true, status: 'cancelled', observation: { commandFateKnown: false } });
    expect(readRunState(project, runId).status).toBe('stopped');
    expect(await control.statusRun(runId)).toMatchObject({ ok: true, status: 'cancelled', observation: { commandFateKnown: false } });
    expect(processGroupIsAlive(child!.pid!)).toBe(true);
    expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('refuses to infer previous-boot death when the current boot is unknown', async () => {
    const { runId } = await interruptedLegacy(true);
    updateRunState(project, runId, state => { state.engineCheckpoint!.bootId = 'fixture-previous-boot'; });
    const recovered = reconcileHostInterruptedRun(project, runId, { currentBootId: undefined });
    expect(recovered).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
    expect(recovered.failureReason).toContain('RECOVERY_FATE_UNKNOWN');
    expect(processGroupIsAlive(child!.pid!)).toBe(true);
  });

  it('accepts recorded cancellation with unknown command fate while rejecting an unfinished decision', () => {
    const result = { ok: true, status: 'cancelled', message: 'Cancellation recorded.', observation: {
      unit: null, unitState: { kind: 'absent' }, runReadable: true, schedulerPid: null,
      schedulerAlive: false, launchInFlight: false, commandFateKnown: false,
    } };
    expect(isCancellationResult(result)).toBe(true);
    expect(isCancellationResult({ ...result, status: 'cancelling' })).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('preserves non-race legacy recovery and cancellation', async () => {
    const { runId, control } = await interruptedLegacy(false);
    expect(reconcileHostInterruptedRun(project, runId)).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' } });
    expect(await control.cancelRun(runId)).toMatchObject({ ok: true });
    expect(processGroupIsAlive(child!.pid!)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('uses proven previous-boot death without signalling a reused live group', async () => {
    const { runId, control } = await interruptedLegacy(true, true);
    expect(reconcileHostInterruptedRun(project, runId)).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' } });
    expect(await control.cancelRun(runId)).toMatchObject({ ok: true });
    expect(processGroupIsAlive(child!.pid!)).toBe(true);
  });
});
