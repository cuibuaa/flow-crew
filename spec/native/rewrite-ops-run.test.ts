import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as host from '../../dist-rewrite/host/process.js';
import { operateRun, runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { identifyEvidence, readEvidence } from '../../dist-rewrite/records/evidence.js';
import { putEvidence } from '../../dist-rewrite/records/state.js';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { stateFixture, get, type StateFixture } from '../fixtures/rewrite-state.js';
vi.mock('../../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 observeRun: vi.fn(), startRun: vi.fn(), stopRun: vi.fn() }));
let f: StateFixture;
beforeEach(async () => {
  f = await stateFixture();
  await f.admit();
  const observed = { unit: f.launch.unit, state: 'inactive' as const, owner: null, evidence: [], detail: 'fixture manager observation' };
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: observed });
  vi.mocked(host.startRun).mockResolvedValue({ ok: true, value: { ...observed, state: 'active' } });
  vi.mocked(host.stopRun).mockResolvedValue({ ok: true, value: observed });
});
afterEach(async () => { vi.clearAllMocks(); await f.close(); });
it('commits the real cancel fence before the manager stop and reuses one operation ID', async () => {
  await f.releaseClaims();
  const p = await f.projection(), intent = { id: 'Cancel', kind: 'cancel' as const, run: 'Run', unit: f.launch.unit,
   expectedCursor: p.cursor }, services = runServices(f);
  vi.mocked(host.stopRun).mockImplementation(async () => { expect((await f.projection()).status).toBe('cancelled'); return { ok: true,
   value: { unit: f.launch.unit, state: 'inactive', owner: null, evidence: [], detail: 'closed' } }; });
  const request = { location: f.location, intent };
  const result = get(await operateRun(request, services));
  expect(result.state).toBe('acknowledged');
  expect(get(await operateRun(request, services))).toMatchObject({intent,state:'acknowledged',detail:'Already ended'});
  expect(host.stopRun).toHaveBeenCalledTimes(2);
  expect((await f.projection()).operations).toHaveLength(2);
  expect((await f.projection()).intents).toHaveLength(1);
});
it('terminal runs cannot resume or start another unit', async () => {
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal' } }]);
  await f.releaseClaims();
  const p = await f.projection();
  expect(await operateRun({ location: f.location, intent: { id: 'Resume', kind: 'resume', run: 'Run', unit: f.launch.unit,
   expectedCursor: p.cursor } }, runServices(f))).toMatchObject({ ok: false, kind: 'conflict' });
  expect(host.startRun).not.toHaveBeenCalled();
});
it('once-only guide binds the parked attempt and preserves exact evidence', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => ({ ok: true, value: { ...get(await native(request)), ending: 'quota', answer: undefined,
   answerRef: undefined } });
  await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
  const p = await f.projection();
  expect(p.currentStage).toBeNull();
  const address = p.attempts.at(-1)!.address, content = get(await putEvidence(f.journal, Buffer.from('Explicit human guidance')));
  await f.releaseClaims();
  const intent = { id: 'Guide', kind: 'guide' as const, run: 'Run', unit: f.launch.unit, expectedCursor: p.cursor, intervention: {
   kind: 'guide' as const, address, content } };
  const result = get(await operateRun({ location: f.location, intent }, runServices(f)));
  expect(result.state).toBe('acknowledged');
  expect(get(await operateRun({ location: f.location, intent }, runServices(f)))).toEqual(result);
  const q = await f.projection();
  expect(await operateRun({ location: f.location, intent: { ...intent, id: 'AnotherGuide', expectedCursor: q.cursor } },
   runServices(f))).toMatchObject({ ok: true });
  const after = await f.projection();
  expect(after.status).toBe('parked');
  expect(after.intents.filter(i => i.kind === 'guide').map(i => i.id)).toEqual(['Guide', 'AnotherGuide']);
  expect(host.startRun).not.toHaveBeenCalled();
});
it.each(['active', 'unknown'] as const)('resume handles %s ownership without a duplicate start', async (state) => {
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'parked', reason: 'attempt_failed', detail: 'pause' } }]);
  await f.releaseClaims();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state, owner: null, evidence: [], detail: '' } });
  expect((await operateRun({ location: f.location, intent: { id: 'Resume', kind: 'resume', run: 'Run', unit: f.launch.unit,
   expectedCursor: (await f.projection()).cursor } }, runServices(f))).ok).toBe(false);
  expect(host.startRun).not.toHaveBeenCalled();
});
it('a closed parked run resumes through the pinned manager without changing its history', async () => {
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'parked', reason: 'attempt_failed', detail: 'pause' } }]);
  const before = await f.projection();
  await f.releaseClaims();
  expect(get(await operateRun({ location: f.location, intent: { id: 'Resume', kind: 'resume', run: 'Run', unit: f.launch.unit,
   expectedCursor: before.cursor } }, runServices(f))).state).toBe('acknowledged');
  expect(host.startRun).toHaveBeenCalledTimes(1);
  expect((await f.projection()).attempts).toEqual(before.attempts);
});
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { publishRunStatus } from '../../dist-rewrite/ops/status.js';
it('source-built CLI status inspects without an obsolete definition root or confinement startup', async () => {
  const published = get(await publishRunStatus(f.location, new Date().toISOString(), null));
  await f.releaseClaims();
  const child = spawn('/usr/bin/nice', ['-n', '19', process.execPath, new URL('../../dist-rewrite/cli.js', import.meta.url).pathname,
   'status', f.location.run], { env: { PATH: process.env.PATH!, HOME: f.root, FC_HOME: dirname(f.database),
   FLOWCREW_STORE_ROOT: f.location.storeRoot, FLOWCREW_RUNTIME_ROOT: dirname(f.configRoot) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  const exit = await new Promise(resolve => child.once('close', resolve));
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.run).toBe(f.location.run);
  expect(result.version).toBe(published.version);
});

it('A13 cancel commits despite a writer advancing after the CLI observed its cursor', async () => {
  const cursor = (await f.projection()).cursor;
  await f.append(f.execution, [{ type: 'ownership', owner: f.execution.owner, state: 'dead' }]);
  await f.releaseClaims();
  const result = get(await operateRun({ location: f.location, intent: { id: 'ConcurrentCancel', kind: 'cancel', run: 'Run',
    unit: f.launch.unit, expectedCursor: cursor } }, runServices(f)));
  expect(result.state).toBe('acknowledged');
  expect((await f.projection()).status).toBe('cancelled');
});

it('A13 an active nonparked run resumes as an idempotent observation without another start', async () => {
  await f.releaseClaims();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'active', owner: null, evidence: [], detail: 'live' } });
  const result = get(await operateRun({ location: f.location, intent: { id: 'AlreadyActive', kind: 'resume', run: 'Run', unit: f.launch.unit,
    expectedCursor: (await f.projection()).cursor } }, runServices(f)));
  expect(result.detail).toBe('Already running'); expect(host.startRun).not.toHaveBeenCalled();
});


it('persistent EPERM closure publishes cancelled attention and retains the unresolved SQL claim', async () => {
  const { claim, release } = await import('../../dist-rewrite/records/state.js');
  const { readRunStatus } = await import('../../dist-rewrite/ops/status.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  await f.releaseClaims();
  const owned = get(await claim(join(f.root, 'unobservable-resource'), f.launch.unit, { database: f.database, holder: f.journal.root }));
  const nativeKill = process.kill.bind(process);
  let signalled = false, timer: NodeJS.Timeout | undefined;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -owned.owner.group) {
      if (signal === 'SIGKILL') signalled = true;
      if (signal === 0 && signalled) throw Object.assign(Error('Authored observation denial'), { code: 'EPERM' });
    }
    return nativeKill(pid, signal);
  });
  vi.mocked(host.stopRun).mockImplementation(async () => {
    const closed = await release(owned, 'retire');
    return closed.ok ? { ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null, evidence: [], detail: 'ESRCH confirmed' } } : closed;
  });
  try {
    const result = get(await Promise.race([operateRun({ location: f.location, intent: { id: 'CancelEPERM', kind: 'cancel', run: 'Run',
      unit: f.launch.unit, expectedCursor: (await f.projection()).cursor } }, runServices(f)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { spy.mockRestore(); reject(Error('EPERM closure exceeded independent test bound')); }, 2 * host.DRAIN_BACKSTOP_MS);
    })]));
    clearTimeout(timer);
    expect(signalled).toBe(true);
    expect(result).toMatchObject({ state: 'not_confirmed_closed' });
    expect(result.detail).toContain('Not confirmed closed:');
    expect(get(readRunStatus(f.location))).toMatchObject({ status: 'cancelled', attention: { reason: 'closure_unconfirmed', detail: result.detail } });
    const db = new DatabaseSync(f.database);
    let claimRows;
    try { claimRows = db.prepare('SELECT owner,epoch FROM resources WHERE epoch=?').all(owned.epoch); } finally { db.close(); }
    expect(claimRows).toEqual([{ owner: JSON.stringify(owned.owner), epoch: owned.epoch }]);
    expect((await f.projection()).attempts).toEqual([]);
    process.stderr.write('Native evidence closure-EPERM-attention ' + JSON.stringify({ platform: process.platform, result, claimRows: claimRows.length }) + '\n');
  } finally { clearTimeout(timer); spy.mockRestore(); get(await release(owned, 'retire')); }
}, 3 * host.DRAIN_BACKSTOP_MS);

it.each(['cancel', 'status'] as const)('claim cleanup after %s durably publishes attention without settling a confirmed cancel twice', async kind => {
  const state = await import('../../dist-rewrite/records/state.js');
  await f.releaseClaims();
  if (kind === 'status') get(await operateRun({ location: f.location, intent: { id: 'PriorCancel', kind: 'cancel', run: 'Run',
    unit: f.launch.unit, expectedCursor: (await f.projection()).cursor } }, runServices(f)));
  const original = state.release;
  let held;
  const spy = vi.spyOn(state, 'release').mockImplementation(async claim => {
    held = claim;
    return { ok: false, kind: 'unknown', detail: 'Claim cleanup closure was not confirmed',
      closure: { state: 'not_confirmed_closed', owner: claim.owner, observation: 'unknown', members: [] } };
  });
  try {
    const result = await operateRun({ location: f.location, intent: { id: 'Cleanup', kind, run: 'Run',
      unit: f.launch.unit, expectedCursor: (await f.projection()).cursor } }, runServices(f));
    expect(result).toMatchObject({ ok: false, kind: 'unknown', detail: 'Claim cleanup closure was not confirmed' });
    const p = await f.projection();
    expect(p.operations).toHaveLength(kind === 'cancel' ? 1 : 2);
    expect(p.operations.at(-1)).toMatchObject({ intent: { id: 'Cleanup', kind }, state: 'acknowledged' });
    expect(p.operations.filter(operation => operation.intent.kind === 'cancel')).toHaveLength(1);
    expect(p.status).toBe('cancelled');
    expect(p.conclusion).toMatchObject({ reason: 'cancelled' });
    expect(p.obligations.map(o => o.kind).sort()).toEqual(['claim-unreleased','closure-unconfirmed']);
    const { readRunStatus } = await import('../../dist-rewrite/ops/status.js');
    expect(get(readRunStatus(f.location))).toMatchObject({ status: 'cancelled', attention: {
      reason: 'closure_unconfirmed', detail: 'Claim cleanup closure was not confirmed' } });
    const reopened = get(await state.openJournal(f.location, 'read'));
    expect(get(await state.readProjection(reopened))).toEqual(p);
  } finally { spy.mockRestore(); if (held) get(await original(held, 'retire')); }
});

// A refused request is an answer to its caller, not evidence of activation death.
it.each(['guide', 'land'] as const)('refused %s leaves a healthy running activation running', async kind => {
  const activation = get(await host.beginOperation());
  try {
  await f.append(f.execution, [{type:'active_time_opened',interval:{id:'Live',owner:activation.owner,openedAt:new Date().toISOString(),spentMs:null}},
    {type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Live',invocation:1}}}]);
  await f.releaseClaims();
  vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'active',owner:f.owner,evidence:[],detail:'live'}});
  const before = await f.projection();
  const result = kind === 'land'
    ? await (await import('../../dist-rewrite/ops/land.js')).land(f.location,runServices(f).process,f.unitContext)
    : await operateRun({location:f.location,intent:{id:'RefusedGuide',kind:'guide',run:'Run',unit:f.launch.unit,expectedCursor:before.cursor,
      intervention:{kind:'guide',address:{run:'Run',stage:'work',attempt:'Live',invocation:1},content:f.ref,
        replacement:{baseRevision:'Revision',plan:f.plan}}}},runServices(f));
  expect(result).toMatchObject({ok:false,kind:'conflict'});
  if (kind === 'land') expect(result).toMatchObject({detail:expect.stringContaining('flowcrew cancel Run first')});
  expect((await f.projection()).status).toBe('running');
  expect((await f.projection()).obligations).toEqual([]);
  } finally { get(await host.endOperation(activation.owner)); }
});
it.each((['closure-unconfirmed','claim-unreleased'] as const).flatMap(kind => (['workflow','unit'] as const).map(entry => [kind,entry] as const)))('pending %s blocks %s entry', async (kind,entry) => {
  await f.append(f.control,[{type:'obligation',open:true,obligation:{kind,detail:'Interrupted activation',members:[]}}]);
  const before = await f.projection();
  if (entry === 'workflow') {
    const {ports} = workflowFixture(f), attempt = vi.spyOn(ports,'attempt');
    expect(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).toMatchObject({ok:false,kind:'conflict'});
    expect(attempt).not.toHaveBeenCalled();
  } else {
    await f.releaseClaims();
    const services = runServices(f), workflow = vi.spyOn(services,'workflowPorts');
    expect(await runUnitEntry(f.location,f.launch.unit,services,new AbortController().signal)).toMatchObject({ok:false,kind:'conflict'});
    expect(workflow).not.toHaveBeenCalled();
  }
  expect((await f.projection()).invocations).toEqual(before.invocations);
});

// Both entry paths and the CLI consume the same projection decision before effects.
it.each([
  {status:'parked', reason:'attempt_failed', obligation:null, exit:3},
  {status:'parked', reason:'accounting_unsettled', obligation:'accounting-unsettled', exit:3},
  {status:'parked', reason:'attempt_failed', obligation:'closure-unconfirmed', exit:1},
  {status:'parked', reason:'attempt_failed', obligation:'claim-unreleased', exit:1},
  ...(['complete','failed','cancelled'] as const).flatMap(status => [null,'closure-unconfirmed','claim-unreleased'].map(obligation => ({
    status, reason:status === 'complete' ? 'completed' : status === 'failed' ? 'attempt_failed' : 'cancelled',
    obligation, exit:status === 'complete' ? 0 : 1
  })))
] as const)('entry $status with $obligation returns CLI exit $exit without new work', async ({status,reason,obligation,exit}) => {
  const conclusion = {status,reason,detail:'Retained conclusion'} as import('../../dist-rewrite/contract/runtime.js').Conclusion;
  if (obligation === 'accounting-unsettled') await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',
    address:{kind:'stage',run:'Run',stage:'work',attempt:'Interrupted',invocation:1}}}]);
  await f.append(f.execution,[{type:'lifecycle',conclusion}]);
  if (obligation) await f.append(f.control,[{type:'obligation',open:true,obligation:{
    kind:obligation as import('../../dist-rewrite/contract/runtime.js').RunObligation['kind'],detail:'Unconfirmed cleanup',members:[]}}]);
  const before = await f.projection(), {ports} = workflowFixture(f), attempt = vi.spyOn(ports,'attempt');
  expect(before.obligations.map(o => o.kind)).toEqual(obligation ? [obligation] : []);
  const blocked = status === 'parked' && (obligation === 'closure-unconfirmed' || obligation === 'claim-unreleased');
  const expected = blocked ? {ok:false,kind:'conflict'} : {ok:true,value:conclusion};
  expect(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).toEqual(expect.objectContaining(expected));
  expect(attempt).not.toHaveBeenCalled();
  await f.releaseClaims();
  const services = runServices(f), workflow = vi.spyOn(services,'workflowPorts');
  expect(await runUnitEntry(f.location,f.launch.unit,services,new AbortController().signal)).toEqual(expect.objectContaining(expected));
  expect(workflow).not.toHaveBeenCalled();
  const {main} = await import('../../dist-rewrite/ops/main.js');
  const stdout:string[] = [], stderr:string[] = [];
  expect(await main(['unit-entry','--run','Run','--unit',JSON.stringify(f.launch.unit)],{
    cwd:f.root,storeRoot:f.location.storeRoot,home:dirname(f.database),runtimeRoot:dirname(f.configRoot),environment:{},
    stdin:new Uint8Array(),abort:new AbortController().signal,
    stdout:async bytes => {stdout.push(Buffer.from(bytes).toString());},
    stderr:async bytes => {stderr.push(Buffer.from(bytes).toString());}
  })).toBe(exit);
  expect(JSON.parse((blocked ? stderr : stdout).at(-1)!)).toMatchObject(
    blocked ? {ok:false,kind:'conflict'} : conclusion);
  expect(await f.projection()).toEqual(before);
  expect(host.observeRun).not.toHaveBeenCalled();
});


it.each(['composition','resume-composition','throw','result','closure'] as const)('activation fatal %s is durable before writer release with exact diagnostic', async fault => {
  const records = await import('../../dist-rewrite/records/state.js');
  const { readRunStatus } = await import('../../dist-rewrite/ops/status.js');
  const activationKind=fault === 'composition' ? 'start' : 'resume';
  await f.append(f.control,[{type:'control_intent',intent:{id:'Activation',kind:activationKind,run:'Run',unit:f.launch.unit,expectedCursor:(await f.projection()).cursor}}]);
  await f.releaseClaims();
  const services = runServices(f), original = services.workflowPorts;
  const diagnostic = 'Synthetic boundary diagnostic: 中文 / exact\nsecond line';
  services.workflowPorts = (...args) => {
    if (fault === 'composition' || fault === 'resume-composition') throw Error(diagnostic);
    const ports = original(...args);
    ports.attempt = async () => {
      if (fault === 'throw') throw Error(diagnostic);
      if (fault === 'closure') return {ok:false,kind:'unknown',detail:diagnostic,closure:{state:'not_confirmed_closed',owner:f.owner,observation:'unknown',members:[]}};
      return {ok:false,kind:'unavailable',detail:diagnostic};
    };
    return ports;
  };
  const nativeRelease = records.release;
  const observed: {projection: Awaited<ReturnType<typeof f.projection>>; events: Awaited<ReturnType<typeof records.readEvents>>}[] = [];
  const release = vi.spyOn(records,'release').mockImplementation(async held => {
    // Capture durable SQL facts before release; assert afterwards so withdrawal checks also release both claims.
    const reopened = get(await records.openJournal(f.location,'read'));
    observed.push({projection:get(await records.readProjection(reopened)),events:await records.readEvents(reopened,0)});
    return nativeRelease(held,'handoff');
  });
  try {
    expect(await runUnitEntry(f.location,f.launch.unit,services,new AbortController().signal)).toMatchObject({
      ok:false,kind:fault === 'result' ? 'unavailable' : 'unknown',detail:diagnostic});
    expect(observed).toHaveLength(2);
    const refusal = { ok: false, kind: fault === 'result' ? 'unavailable' : 'unknown', detail: diagnostic };
    const diagnosticBytes = Buffer.from(JSON.stringify({ refusal })), diagnosticRef = identifyEvidence(diagnosticBytes);
    const endingDetail = fault === 'closure' ? `closure-unconfirmed: ${diagnostic}`
      : `${refusal.kind}: ${diagnostic}; diagnostic ${diagnosticRef.path}`;
    if (fault !== 'closure') expect(Buffer.from(get(await readEvidence(f.journal, diagnosticRef)))).toEqual(diagnosticBytes);
    for (const snapshot of observed) {
      expect(snapshot.projection).toMatchObject({status:'parked',conclusion:{status:'parked',reason:fault === 'closure' ? 'closure_unconfirmed' : 'recovery_unknown',detail:endingDetail}});
      expect(get(snapshot.events).filter(e => e.payload.type === 'lifecycle' && e.payload.conclusion.detail === endingDetail)).toHaveLength(fault === 'closure' ? 0 : 1);
    }
    const published=get(readRunStatus(f.location));
    expect(published).toMatchObject({status:'parked',attention:{detail:fault === 'closure' ? diagnostic : endingDetail}});
    expect(published.attention?.cause).toBe(fault==='resume-composition' ? 'resume_refused' : undefined);
    expect((await f.projection()).conclusion?.cause).toBe(published.attention?.cause);
    if(fault==='resume-composition')expect(published.backstop).toMatchObject({gateSuffix:0,failureSuffix:0,condition:null});
  } finally {release.mockRestore();}
});


it('cancel reports in_progress while a healthy recorder retains evidence without closing its accounting', async () => {
  await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Live',owner:f.owner,
    openedAt:new Date().toISOString(),spentMs:null}}]);
  await f.releaseClaims();
  const observation = {unit:f.launch.unit,state:'active' as const,owner:f.owner,evidence:[],detail:'Recorder retaining evidence'};
  vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
  vi.mocked(host.stopRun).mockResolvedValue({ok:true,value:observation});
  const result = get(await operateRun({location:f.location,intent:{id:'Closing',kind:'cancel',run:'Run',unit:f.launch.unit,
    expectedCursor:(await f.projection()).cursor}},runServices(f)));
  expect(result).toMatchObject({state:'in_progress',observation});
  const p = await f.projection();
  expect(p.status).toBe('cancelled');expect(p.obligations).toEqual([]);
  expect(p.intervals).toEqual([expect.objectContaining({id:'Live',spentMs:null})]);
  expect(p.intervals[0].closed).toBeUndefined();
});

it.each([false,true])('resume compares frozen input identities only: frozen=%s',async frozen=>{
  await f.close();
  f=await stateFixture({inputs:[{id:'mutable',path:'changing.txt',kind:'file',frozen}]});
  await f.admit();
  const {writeFile}=await import('node:fs/promises');
  const {join}=await import('node:path');
  await writeFile(join(f.project,'changing.txt'),'changed after admission');
  await f.releaseClaims();
  const result=await operateRun({location:f.location,intent:{id:'ChangedInputResume',kind:'resume',run:'Run',unit:f.launch.unit,
    expectedCursor:(await f.projection()).cursor}},runServices(f));
  if(frozen){
    expect(result).toMatchObject({ok:false,kind:'conflict',detail:'Frozen input identity changed'});
    expect(host.startRun).not.toHaveBeenCalled();
  }else{
    expect(result).toMatchObject({ok:true,value:{state:'acknowledged'}});
    expect(host.startRun).toHaveBeenCalledOnce();
  }
});
