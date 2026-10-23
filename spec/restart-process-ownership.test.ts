import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, fcGlobalDir, readRunState, readStageStatus, writeStageStatus, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { checkpointConsumers, reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { processStartToken, processStartTokensMatch } from '../src/run-lock.js';
import * as liveness from '../src/process-liveness.js';

let root: string, project: string, previous: string, controller: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'n51-process-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (controller && controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
  if (existsSync(join(root, 'ready'))) {
    const state = readRunState(project, readFileSync(join(root, 'ready'), 'utf8'));
    for (const group of state.engineCheckpoint?.processes ?? []) {
      if (group.processStart && processStartTokensMatch(group.processStart, processStartToken(group.pid))) {
        try { process.kill(-group.pid, 'SIGKILL'); } catch { /* owned group already retired */ }
      }
    }
  }
  controller = undefined;
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});

it('retains sampled usage through interruption intent, settlement and repeated recovery', () => {
  const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  updateRunState(project, runId, state => {
    state.status = 'running';
    state.engineCheckpoint = { version: 2, runId, projectDir: project, bootId: 'old-boot', pid: 101, at: new Date().toISOString(), processes: [] };
  });
  const status = beginStageAttempt(project, runId, 'work', 0, '2026-10-01T00:00:00.000Z');
  const usage = { tokens_in: 30, tokens_out: 4, cost_usd: 0.03, tokenUsage: 'partial' as const, costUsage: 'partial' as const };
  writeStageStatus(project, runId, 'work', { ...status, attempts: [{ ...status.attempts![0], ...usage }] });
  expect(reconcileHostInterruptedRun(project, runId, { currentBootId: 'new-boot' }).recovery?.kind).toBe('resumable');
  expect(readStageStatus(project, runId, 'work').attempts?.[0]).toMatchObject({ ...usage, exitCode: 143, status: 'failed' });
  reconcileHostInterruptedRun(project, runId, { currentBootId: 'new-boot' });
  expect(readRunState(project, runId).stages.work.attempts).toHaveLength(1);
});

it.each(['alive', 'unknown'] as const)('refuses %s checkpoint controller without settling execution', fate => {
  const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
  updateRunState(project, runId, state => {
    state.engineCheckpoint = { version: 2, runId, projectDir: project, bootId: 'fixture-boot', pid: process.pid,
      processStart: processStartToken(process.pid), at: new Date().toISOString(), processes: [] };
  });
  const before = readFileSync(join(runDir(project, runId), 'run.json'), 'utf8');
  vi.spyOn(liveness, 'processLiveness').mockReturnValue(fate);
  expect(() => reconcileHostInterruptedRun(project, runId, { currentBootId: 'fixture-boot' })).toThrow('RECOVERY_FATE_CHANGED');
  expect(readFileSync(join(runDir(project, runId), 'run.json'), 'utf8')).toBe(before);
});

it('ignores a reused command group during recovery without signalling it', () => {
  const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
  updateRunState(project, runId, state => {
    state.engineCheckpoint = {
      version: 2, runId, projectDir: project, bootId: 'fixture-boot', pid: 101,
      at: new Date().toISOString(), processes: [{ pid: 202, processStart: { kind: 'linux', value: '100' } }],
    };
  });
  vi.spyOn(liveness, 'processLiveness').mockReturnValue('dead');
  vi.spyOn(liveness, 'processGroupIsAlive').mockReturnValue(true);
  const token = vi.spyOn(liveness, 'processStartToken').mockReturnValue({ kind: 'linux', value: '200' });
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const checkpoint = readRunState(project, runId).engineCheckpoint!;
  expect(reconcileHostInterruptedRun(project, runId, { currentBootId: 'fixture-boot' })).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' } });
  expect(checkpointConsumers(checkpoint, { currentBootId: 'fixture-boot' })).toEqual([]);
  expect(signal).not.toHaveBeenCalled();
  // Unavailable identity still protects surviving consumers from both resumption and a wrong kill.
  token.mockReturnValue(undefined);
  expect(checkpointConsumers(checkpoint, { currentBootId: 'fixture-boot', retire: true })).toEqual([202]);
  expect(signal).not.toHaveBeenCalled();
  token.mockReturnValue({ kind: 'linux', value: '100' });
  expect(checkpointConsumers(checkpoint, { currentBootId: 'fixture-boot', retire: true })).toEqual([202]);
  expect(signal).toHaveBeenCalledExactlyOnceWith(-202, 'SIGKILL');
});

const launch = `
import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url'; import {syncBuiltinESMExports} from 'node:module';
const [runtime,root,project,point] = process.argv.slice(1);
const load = name => import(pathToFileURL(path.join(runtime,'dist',name+'.js')));
const store = await load('store'); store.setFcGlobalDir(path.join(root,'store'));
const recovery = await load('restart-recovery'); const locks = await load('run-lock'); const base = await load('adapters/base');
const reservation = store.reserveRun(project);
const {runId,runDirPath} = store.initializeReservedRun(project,reservation.runId,'fixture','name: fixture\\nstages: []\\n',['done','work']);
store.writeStageStatus(project,runId,'done',{status:'complete',retries:0,attempts:[{index:1,status:'complete',startedAt:new Date().toISOString(),exitCode:0}]});
store.beginStageAttempt(project,runId,'work',0);
store.updateRunState(project,runId,state=>{state.engineCheckpoint=recovery.captureEngineCheckpoint(project,runId)});
fs.writeFileSync(path.join(runDirPath,'scheduler.pid'),String(process.pid)); locks.writeSchedulerProcessIdentity(runDirPath,runId);
fs.writeFileSync(path.join(root,'ready'),runId);
const stale = store.readRunState(project,runId);
const rename = fs.renameSync;
if(point==='before-publication') {
 fs.renameSync = function(from,to) {
   if(String(to)===path.join(runDirPath,'run.json') && JSON.parse(fs.readFileSync(from,'utf8')).engineCheckpoint?.processes?.length) process.kill(process.pid,'SIGKILL');
   return rename(from,to);
 }; syncBuiltinESMExports();
}
const code = 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
const result = base.withRunProcessOwnership(project,runId,()=>base.execWithStdin(process.execPath,['-e',code,path.join(project,'consumer')],'',{cwd:project,timeout_ms:10000}));
if(point==='after-launch') store.writeRunState(project,runId,stale);
await result;
`;

async function start(point: string) {
  controller = spawn(process.execPath, ['--input-type=module', '-e', launch, resolve('.'), root, project, point], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') } });
  let diagnostic = '';
  controller.stderr!.on('data', bytes => { diagnostic += bytes; });
  const exited = new Promise<void>(done => controller!.once('close', () => done()));
  for (let i = 0; i < 500 && !existsSync(join(root, 'ready')); i++) await delay(10);
  expect(existsSync(join(root, 'ready')), diagnostic).toBe(true);
  return { id: readFileSync(join(root, 'ready'), 'utf8'), exited };
}

it.skipIf(process.platform !== 'linux')('retires an owned orphan before retaining its unknown attempt; stale writers cannot erase ownership', async () => {
  const { id, exited } = await start('after-launch');
  for (let i = 0; i < 500 && !existsSync(join(project, 'consumer')); i++) await delay(10);
  expect(existsSync(join(project, 'consumer'))).toBe(true);
  expect(readRunState(project, id).engineCheckpoint?.processes).toHaveLength(1);
  const done = readFileSync(join(runDir(project, id), 'stages/done/status.json'), 'utf8');
  controller!.kill('SIGKILL'); await exited;
  expect(() => reconcileHostInterruptedRun(project, id)).toThrow('RECOVERY_CONSUMERS_ACTIVE');
  expect(readRunState(project, id).stages.work.status).toBe('running');
  let state;
  for (let i = 0; i < 500; i++) {
    try { state = reconcileHostInterruptedRun(project, id); break; }
    catch (error) { if (!String(error).includes('RECOVERY_CONSUMERS_ACTIVE')) throw error; await delay(10); }
  }
  expect(state).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' }, stages: { done: { status: 'complete' }, work: { status: 'pending', attempts: [{ status: 'failed', exitCode: 143, tokenUsage: 'unknown' }] } } });
  expect(readFileSync(join(runDir(project, id), 'stages/done/status.json'), 'utf8')).toBe(done);
  reconcileHostInterruptedRun(project, id);
  expect(readRunState(project, id).stages.work.attempts).toHaveLength(1);
  expect(readFileSync(join(runDir(project, id), 'events.jsonl'), 'utf8').match(/recovery_reconciled/g)).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('a crash before command ownership publication never releases the command to write', async () => {
  const { id, exited } = await start('before-publication');
  await exited; await delay(100);
  expect(existsSync(join(project, 'consumer'))).toBe(false);
  expect(readRunState(project, id).engineCheckpoint?.processes).toEqual([]);
  expect(reconcileHostInterruptedRun(project, id).recovery?.kind).toBe('resumable');
});
