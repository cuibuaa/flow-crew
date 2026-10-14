import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { processStartToken, processStartTokensMatch } from '../src/run-lock.js';
import { processGroupIsAlive } from '../src/process-liveness.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { TaskRegistry } from '../src/task-registry.js';
import type { SupervisorBackend } from '../src/supervision.js';
import { isCancellationResult } from '../src/cancellation-client.js';

let root: string, project: string, previous: string, controller: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'race-lifecycle-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (controller && controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
  if (existsSync(join(root, 'ready.json'))) {
    const { parent, child } = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
    for (const id of [parent, child]) for (const group of readRunState(project, id).engineCheckpoint?.processes ?? []) {
      if (group.processStart && processStartTokensMatch(group.processStart, processStartToken(group.pid))) {
        try { process.kill(-group.pid, 'SIGKILL'); } catch { /* owned group already retired */ }
      }
    }
  }
  controller = undefined;
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});

const nestedLaunch = `
import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const [runtime,root,project] = process.argv.slice(1);
const load = name => import(pathToFileURL(path.join(runtime,'dist',name+'.js')));
const store = await load('store'); store.setFcGlobalDir(path.join(root,'store'));
const recovery = await load('restart-recovery'); const locks = await load('run-lock'); const base = await load('adapters/base');
function prepare() {
 const {runId,runDirPath} = store.createRun(project,'fixture','name: fixture\\nstages: []\\n',['work']);
 store.beginStageAttempt(project,runId,'work',0);
 store.updateRunState(project,runId,state=>{state.engineCheckpoint=recovery.captureEngineCheckpoint(project,runId)});
 fs.writeFileSync(path.join(runDirPath,'scheduler.pid'),String(process.pid)); locks.writeSchedulerProcessIdentity(runDirPath,runId);
 return runId;
}
const parent=prepare(),child=prepare();
fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({parent,child}));
const code='require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
await base.withRunProcessOwnership(project,parent,()=>base.withRunProcessOwnership(project,child,()=>
 base.withRunProcessOwnership(project,child,()=>base.execWithStdin(process.execPath,['-e',code,path.join(project,'consumer')],'',{cwd:project,timeout_ms:10000}))));
`;

async function startNestedWriter() {
  controller = spawn(process.execPath, ['--input-type=module', '-e', nestedLaunch, resolve('.'), root, project],
    { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') } });
  let diagnostic = '';
  controller.stderr!.on('data', bytes => { diagnostic += bytes; });
  const exited = new Promise<void>(done => controller!.once('close', () => done()));
  for (let i = 0; i < 500 && !existsSync(join(project, 'consumer')); i++) await delay(10);
  expect(existsSync(join(project, 'consumer')), diagnostic).toBe(true);
  const { parent, child } = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
  return { parent, child, exited };
}

function cancellationCoordinator(timeoutMs = 3000) {
  const units: SupervisorBackend = {
    isActive: async () => ({ kind: 'absent' }), runUnit: async () => {}, stopUnit: async () => {}, journalTail: async () => '',
  };
  return new RunCancellationCoordinator({ registry: new TaskRegistry({ baseDir: join(root, 'registry') }), units,
    runsDir: join(fcGlobalDir(), 'runs'), timeoutMs, pollMs: 10, signalGraceMs: 0 });
}

it.skipIf(process.platform !== 'linux')('retires a nested candidate writer before its interrupted parent can resume', async () => {
  const { parent, child, exited } = await startNestedWriter();
  const childProcesses = readRunState(project, child).engineCheckpoint?.processes;
  expect(childProcesses).toHaveLength(1);
  expect(readRunState(project, parent).engineCheckpoint?.processes).toEqual(childProcesses);
  controller!.kill('SIGKILL'); await exited;
  expect(() => reconcileHostInterruptedRun(project, parent)).toThrow('RECOVERY_CONSUMERS_ACTIVE');
  expect(readRunState(project, parent).stages.work.status).toBe('running');
  let state;
  for (let i = 0; i < 500; i++) {
    try { state = reconcileHostInterruptedRun(project, parent); break; }
    catch (error) { if (!String(error).includes('RECOVERY_CONSUMERS_ACTIVE')) throw error; await delay(10); }
  }
  expect(state).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' }, stages: {
    work: { status: 'pending', attempts: [{ status: 'failed', exitCode: 143, tokenUsage: 'unknown' }] },
  } });
  expect(processStartTokensMatch(childProcesses![0].processStart, processStartToken(childProcesses![0].pid))).toBe(false);
});

it.skipIf(process.platform !== 'linux').each(['running', 'stopped'] as const)('records cancellation and retires the escaped candidate of its %s parent', async status => {
  const { parent, child, exited } = await startNestedWriter();
  const pid = readRunState(project, child).engineCheckpoint!.processes![0].pid;
  controller!.kill('SIGKILL'); await exited;
  if (status === 'stopped') updateRunState(project, parent, state => { state.status = 'stopped'; });
  const coordinator = cancellationCoordinator();
  expect(await coordinator.statusRun(parent)).toMatchObject({
    ok: status === 'stopped', status: status === 'stopped' ? 'cancelled' : 'cancelling',
    observation: { activeCommandPids: [pid] },
  });
  expect(await coordinator.cancelRun(parent)).toMatchObject({ ok: true });
  expect(processGroupIsAlive(pid)).toBe(false);
  expect(readRunState(project, parent).status).toBe('stopped');
  expect(await coordinator.statusRun(parent)).toMatchObject({ ok: true, status: 'cancelled' });
});

it.skipIf(process.platform !== 'linux')('records cancellation without signalling a live group whose identity is unavailable', async () => {
  const { parent, child, exited } = await startNestedWriter();
  const pid = readRunState(project, child).engineCheckpoint!.processes![0].pid;
  controller!.kill('SIGKILL'); await exited;
  updateRunState(project, parent, state => {
    state.engineCheckpoint!.at = '2000-01-01T00:00:00.000Z';
    delete state.engineCheckpoint!.processes![0].processStart;
  });
  const coordinator = cancellationCoordinator(0);
  const signal = vi.spyOn(process, 'kill');
  expect(await coordinator.cancelRun(parent)).toMatchObject({
    ok: true, status: 'cancelled', observation: { activeCommandPids: [pid] },
  });
  expect(processGroupIsAlive(pid)).toBe(true);
  expect(readRunState(project, parent).status).toBe('stopped');
  expect(await coordinator.statusRun(parent)).toMatchObject({
    ok: true, status: 'cancelled', observation: { activeCommandPids: [pid] },
  });
  expect(signal.mock.calls.filter(([target, sent]) => Math.abs(target) === pid && sent !== 0)).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('preserves a prior-boot terminal run without signalling a current live group', async () => {
  const { parent, child, exited } = await startNestedWriter();
  const pid = readRunState(project, child).engineCheckpoint!.processes![0].pid;
  controller!.kill('SIGKILL'); await exited;
  updateRunState(project, parent, state => {
    state.status = 'stopped'; state.engineCheckpoint!.bootId = 'fixture-previous-boot';
  });
  const coordinator = cancellationCoordinator(0);
  expect(await coordinator.statusRun(parent)).toMatchObject({ ok: true, status: 'cancelled' });
  expect(await coordinator.cancelRun(parent)).toMatchObject({ ok: true });
  expect(processGroupIsAlive(pid)).toBe(true);
  expect(readRunState(project, parent).status).toBe('stopped');
});

it('accepts a durable cancellation decision whose observation contains an active command group', () => {
  expect(isCancellationResult({ ok: true, status: 'cancelled', message: 'Cancellation recorded.', observation: {
    unit: null, unitState: { kind: 'absent' }, runReadable: true, schedulerPid: null,
    schedulerAlive: false, launchInFlight: false, activeCommandPids: [31337],
  } })).toBe(true);
});

