import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalRunId, resolveRunIdentity } from '../src/cancellation-policy.js';
import { claimLaunchIntent, inspectRunScheduler, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { readRunIndexRecords } from '../src/run-index.js';
import { TaskRegistry } from '../src/task-registry.js';
import {
  beginStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus, runDir,
  runsRoot, setFcGlobalDir, updateRunState, writeRunState, writeStageStatus,
} from '../src/store.js';

let root: string, project: string, runId: string, directory: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-cancellation-identity-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runId;
  directory = runDir(project, runId);
  writeStageStatus(project, runId, 'work', { status: 'pending', retries: 0 });
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function checkpoint() {
  beginStageAttempt(project, runId, 'work', 0, '2026-10-03T00:00:00.000Z');
  updateRunState(project, runId, state => {
    state.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: 'old-boot', generation: 'fixture-generation', pid: 2147483647, at: '2026-10-03T00:00:00.000Z' };
    state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4;
  });
}

const cancelChild = `
import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url'; import {syncBuiltinESMExports} from 'node:module';
const [runtime,fc,id,canonical,ack,queued]=process.argv.slice(1);const lock=path.join(fc,'runs',canonical,'.run-state.lock');const open=fs.openSync;
fs.openSync=function(file,...args){try{return open(file,...args)}catch(e){if(String(file)===lock&&e.code==='EEXIST')fs.writeFileSync(queued,'queued');throw e}};syncBuiltinESMExports();
const load=n=>import(pathToFileURL(path.join(runtime,'dist',n+'.js')).href);const store=await load('store');store.setFcGlobalDir(fc);
const {RunCancellationCoordinator}=await load('run-control');const c=new RunCancellationCoordinator({registry:{list:()=>[]},units:{isActive:async()=>({kind:'absent'}),stopUnit:async()=>{}},runsDir:path.join(fc,'runs')});
const result=await c.cancelRun(id);const dir=path.join(fc,'runs',canonical);
fs.writeFileSync(ack,JSON.stringify({result,raw:fs.readFileSync(path.join(dir,'run.json'),'utf8'),ledger:fs.readFileSync(path.join(dir,'stages/work/status.json'),'utf8')}));
`;

// Hold each real publication rename while a separate native coordinator tries
// the accepted alias. A fresh directory prevents stale acknowledgement receipts
// from satisfying the synchronization predicate.
const raceChild = `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const [runtime,fc,project,id,point]=process.argv.slice(1);const dir=path.join(fc,'runs',id),ack=path.join(fc,'ack.json'),queued=path.join(fc,'queued');
const load=n=>import(pathToFileURL(path.join(runtime,'dist',n+'.js')).href);const store=await load('store');store.setFcGlobalDir(fc);const recovery=await load('restart-recovery');
const rename=fs.renameSync;let hit=false,early=false,child;const sleep=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
fs.renameSync=function(from,to){let boundary;try{const v=JSON.parse(fs.readFileSync(from,'utf8'));if(String(to)===path.join(dir,'stages/work/status.json')&&v.status==='failed')boundary='closed_ledger_before';else if(String(to)===path.join(dir,'run.json'))boundary=v.recoveryIntent?.phase==='committed'?'commit_before':v.stages?.work?.status==='failed'?'closed_projection_before':undefined}catch{}
if(!hit&&boundary===point){hit=true;child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(cancelChild)},runtime,fc,'accepted_alias',id,ack,queued],{stdio:'ignore'});const deadline=Date.now()+8000;while(!fs.existsSync(ack)&&!fs.existsSync(queued)){if(Date.now()>deadline)throw new Error('lock/ack boundary not reached');sleep()}early=fs.existsSync(ack)}return rename(from,to)};syncBuiltinESMExports();
try {
 recovery.reconcileHostInterruptedRun(project,id,{currentBootId:'new-boot',currentGeneration:'fixture-generation'});
 fs.renameSync=rename;syncBuiltinESMExports();
 if(child)await new Promise((done,fail)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');fail(new Error('canceller did not settle'))},8000);child.once('close',()=>{clearTimeout(timer);done()})});
 const receipt=JSON.parse(fs.readFileSync(ack,'utf8'));console.log(JSON.stringify({hit,early,queued:fs.existsSync(queued),result:receipt.result.status,rawPreserved:receipt.raw===fs.readFileSync(path.join(dir,'run.json'),'utf8'),ledgerPreserved:receipt.ledger===fs.readFileSync(path.join(dir,'stages/work/status.json'),'utf8'),status:store.readRunState(project,id).status}));
} finally {fs.renameSync=rename;syncBuiltinESMExports();if(child&&child.exitCode===null)child.kill('SIGKILL')}
`;

const startupChild = `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const [runtime,fc,project,id]=process.argv.slice(1);const dir=path.join(fc,'runs',id),ack=path.join(fc,'ack.json'),queued=path.join(fc,'queued');const load=n=>import(pathToFileURL(path.join(runtime,'dist',n+'.js')).href);
const store=await load('store');store.setFcGlobalDir(fc);const scheduler=await load('scheduler');const read=fs.readFileSync;let hit=false,executions=0;
fs.readFileSync=function(file,...args){const bytes=read(file,...args);const stack=new Error().stack;if(!hit&&String(file)===path.join(dir,'run.json')&&stack.includes('readArchivedRunState')&&stack.includes('runWorkflow')){hit=true;const c=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(cancelChild)},runtime,fc,id,id,ack,queued],{encoding:'utf8',timeout:8000});if(c.status!==0)throw new Error(c.stderr)}return bytes};syncBuiltinESMExports();
try {
 const workflow=scheduler.WorkflowConfigSchema.parse({name:'fixture',defaults:{max_iterations:1},stages:[{id:'work',role:'coder',scope:[],depends_on:[],dependency_reasons:{},prompt_template:'Owned deterministic control.',artifact_contract:{version:1,produces:[],reads:[],replays:[]}}]});
 const result=await scheduler.runWorkflow(workflow,'name: fixture',project,{run:async()=>{executions++;return {exitCode:0,output:'Owned control.',duration_ms:1,writes:[]}}},new Map(),undefined,undefined,id);
 const receipt=JSON.parse(read(ack,'utf8'));console.log(JSON.stringify({hit,executions,status:result.status,rawPreserved:receipt.raw===read(path.join(dir,'run.json'),'utf8'),ledgerPreserved:receipt.ledger===read(path.join(dir,'stages/work/status.json'),'utf8')}));
} finally {fs.readFileSync=read;syncBuiltinESMExports()}
`;

const claimRaceChild = `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const [runtime,fc,id]=process.argv.slice(1),run=path.join(fc,'runs',id);const load=n=>import(pathToFileURL(path.join(runtime,'dist',n+'.js')).href);const store=await load('store');store.setFcGlobalDir(fc);const lock=await load('run-lock');const {RunCancellationCoordinator}=await load('run-control');
const open=fs.openSync;let hit=false,owned;
fs.openSync=function(file,...args){if(!hit&&String(file)===path.join(run,'.run-state.lock')){hit=true;owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(run,'scheduler.pid'),String(owned.pid));lock.writeSchedulerProcessIdentity(run,id,owned.pid)}return open(file,...args)};syncBuiltinESMExports();
try {
 const c=new RunCancellationCoordinator({registry:{list:()=>[]},units:{isActive:async()=>({kind:'absent'}),stopUnit:async()=>{}},signalGraceMs:0,timeoutMs:0});const result=await c.cancelRun(id);console.log(JSON.stringify({hit,status:result.status,ok:result.ok,stateStatus:store.readRunState('',id).status}));
} finally {fs.openSync=open;syncBuiltinESMExports();if(owned&&owned.exitCode===null){owned.kill('SIGTERM');await new Promise(done=>{const timer=setTimeout(()=>{owned.kill('SIGKILL');done()},2000);owned.once('close',()=>{clearTimeout(timer);done()})})}}
`;

describe('canonical cancellation and committed publication fences', () => {
  it('uses the same identity and live scheduler for an accepted directory alias', () => {
    symlinkSync(runId, join(runsRoot(), 'accepted_alias'));
    writeFileSync(join(directory, 'scheduler.pid'), String(process.pid));
    writeSchedulerProcessIdentity(join(runsRoot(), 'accepted_alias'), 'accepted_alias');
    expect(canonicalRunId(runsRoot(), 'accepted_alias')).toBe(runId);
    expect(inspectRunScheduler('accepted_alias', join(runsRoot(), 'accepted_alias')).kind).toBe('live');
    expect(inspectRunScheduler('other_run', directory).kind).toBe('corrupt');
  });

  it.each(['closed_ledger_before', 'closed_projection_before', 'commit_before'])('serializes alias cancellation at %s', point => {
    checkpoint(); symlinkSync(runId, join(runsRoot(), 'accepted_alias'));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', raceChild, resolve('.'), fcGlobalDir(), project, runId, point], {
      cwd: project, encoding: 'utf8', timeout: 25000,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toMatchObject({ hit: true, early: false, queued: true, result: 'cancelled', status: 'stopped', rawPreserved: true, ledgerPreserved: true });
  });

  it('rechecks cancellation committed after the initial startup status read', () => {
    updateRunState(project, runId, state => { state.status = 'parked'; state.currentIteration = 1; state.maxIterations = 2; });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', startupChild, resolve('.'), fcGlobalDir(), project, runId], {
      cwd: project, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toEqual({ hit: true, executions: 0, status: 'stopped', rawPreserved: true, ledgerPreserved: true });
  });

  it('does not acknowledge cancellation past a scheduler claim after the last observation', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', claimRaceChild, resolve('.'), fcGlobalDir(), runId], {
      cwd: project, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toEqual({ hit: true, status: 'cancelling', ok: false, stateStatus: 'running' });
  });

  it('preserves an acknowledged stop against stale run and stage writers and new launch claims', async () => {
    const stale = readRunState(project, runId);
    const beforeLedger = readFileSync(join(directory, 'stages/work/status.json'), 'utf8');
    const c = new RunCancellationCoordinator({ registry: { list: () => [] } as never, units: { isActive: async () => ({ kind: 'absent' }), stopUnit: async () => {} } as never });
    expect((await c.cancelRun(runId)).status).toBe('cancelled');
    const acknowledged = readFileSync(join(directory, 'run.json'), 'utf8');
    expect(() => writeRunState(project, runId, stale)).toThrow('RUN_CANCELLED');
    expect(() => writeStageStatus(project, runId, 'work', { status: 'running', retries: 0 })).toThrow('RUN_CANCELLED');
    expect(() => claimLaunchIntent(project, runId)).toThrow('RUN_CANCELLED');
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(acknowledged);
    expect(readFileSync(join(directory, 'stages/work/status.json'), 'utf8')).toBe(beforeLedger);
  });

  it('preserves an old stopped projection byte for byte on a no-op update', () => {
    const legacy = { ...readRunState(project, runId), status: 'stopped' as const };
    delete legacy.stateFormat;
    const acknowledged = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(join(directory, 'run.json'), acknowledged);
    expect(updateRunState(project, runId, () => {}).status).toBe('stopped');
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(acknowledged);
  });

  it('keeps an explicit private run binding out of the global index for the same run ID', async () => {
    const privateProject = join(root, 'private-project'); mkdirSync(privateProject);
    const privateDirectory = join(root, 'legacy-runs', runId); mkdirSync(privateDirectory, { recursive: true });
    writeFileSync(join(privateDirectory, 'run.json'), JSON.stringify({ ...readRunState(project, runId), projectDir: privateProject }));
    const registry = new TaskRegistry({ baseDir: join(root, 'task-registry') });
    const task = registry.create({ kind: 'quick', name: 'Private binding', projectDir: privateProject, brief_text: 'Owned control.' });
    registry.update(task.id, { run_id: privateDirectory, status: 'running' });
    const indexBefore = readRunIndexRecords(project);
    const globalBefore = readFileSync(join(directory, 'run.json'), 'utf8');
    const coordinator = new RunCancellationCoordinator({ registry, units: { isActive: async () => ({ kind: 'absent' }), stopUnit: async () => {} } as never });
    expect((await coordinator.cancelTask(task.id)).status).toBe('cancelled');
    expect(JSON.parse(readFileSync(join(privateDirectory, 'run.json'), 'utf8')).status).toBe('stopped');
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(globalBefore);
    expect(readRunIndexRecords(project)).toEqual(indexBefore);
  });

  it.each(['outward', 'record-mismatch', 'projection-hardlink'])('refuses ambiguous control authority: %s', kind => {
    if (kind === 'outward') {
      const outside = join(root, 'other_run'); mkdirSync(outside); symlinkSync(outside, join(runsRoot(), 'alias'));
      expect(() => canonicalRunId(runsRoot(), 'alias')).toThrow('RUN_IDENTITY_OUTSIDE_ROOT');
    } else if (kind === 'record-mismatch') {
      const state = readRunState(project, runId); state.runId = 'other_run'; writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
      expect(() => resolveRunIdentity(directory)).toThrow('RUN_IDENTITY_BINDING');
    } else {
      linkSync(join(directory, 'run.json'), join(root, 'projection-copy'));
      expect(() => resolveRunIdentity(directory)).toThrow('RUN_IDENTITY_PROJECTION_ALIAS');
    }
  });
});

describe('recovery authority remains required', () => {
  it.each([
    ['generation', 'RECOVERY_GENERATION_MISMATCH'],
    ['same-boot', 'RECOVERY_FATE_UNKNOWN'],
    ['unknown-boot', 'RECOVERY_FATE_UNKNOWN'],
    ['unbound-plan', 'RECOVERY_PLAN_UNBOUND'],
    ['unbound-attempt', 'RECOVERY_ATTEMPT_UNBOUND'],
    ['missing-intent', 'RECOVERY_INTENT_REQUIRED'],
  ])('retains %s refusal without changing the execution ledger', (kind, reason) => {
    checkpoint();
    if (kind === 'unknown-boot') updateRunState(project, runId, state => { delete state.engineCheckpoint!.bootId; });
    if (kind === 'unbound-plan') updateRunState(project, runId, state => { state.planControl = { version: 1, stages: [], capabilities: [] }; });
    if (kind === 'unbound-attempt') writeFileSync(join(directory, 'stages/work/status.json'), JSON.stringify({ status: 'pending', retries: 0 }));
    if (kind === 'missing-intent') {
      const ledger = readStageStatus(project, runId, 'work'); ledger.status = 'failed';
      Object.assign(ledger.attempts!.at(-1)!, { status: 'failed', exitCode: 143, error: 'HOST_RESTART_INTERRUPTED: no durable intent' });
      writeStageStatus(project, runId, 'work', ledger);
    }
    const ledger = readFileSync(join(directory, 'stages/work/status.json'), 'utf8');
    const state = reconcileHostInterruptedRun(project, runId, { currentBootId: kind === 'same-boot' ? 'old-boot' : 'new-boot', currentGeneration: kind === 'generation' ? 'different' : 'fixture-generation' });
    expect(state.recovery?.kind).toBe('blocked'); expect(state.failureReason).toContain(reason);
    expect(readFileSync(join(directory, 'stages/work/status.json'), 'utf8')).toBe(ledger);
  });

  it('requires an exactly bound checkpoint', () => {
    checkpoint(); updateRunState(project, runId, state => { state.engineCheckpoint!.runId = 'different'; });
    expect(() => reconcileHostInterruptedRun(project, runId, { currentBootId: 'new-boot', currentGeneration: 'fixture-generation' })).toThrow('RECOVERY_RUN_BINDING');
  });

  it('reconciles an accepted alias without replacing the retry/iteration budget or claiming success', () => {
    checkpoint(); symlinkSync(runId, join(runsRoot(), 'accepted_alias'));
    const state = reconcileHostInterruptedRun(project, 'accepted_alias', { currentBootId: 'new-boot', currentGeneration: 'fixture-generation' });
    expect(state).toMatchObject({ status: 'parked', currentIteration: 2, maxIterations: 3, maxRetries: 4, recovery: { kind: 'resumable' }, stages: { work: { status: 'pending', retries: 0 } } });
    expect(state.stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143, tokenUsage: 'unknown' });
  });
});
