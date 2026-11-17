import {RUN_STATUS_LAYOUT} from '../../dist-rewrite/contract/runtime.js';
import {spawn,type ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {stateFixture,get,type StateFixture} from '../fixtures/rewrite-state.js';
import {publishRunStatus,readRunStatus} from '../../dist-rewrite/ops/status.js';
import {withState} from '../../dist-rewrite/records/state.js';
import {validStatus} from '../../rewrite-src/contract/status.mjs';
vi.mock('node:fs',async original => {
  const actual = await original<typeof import('node:fs')>();
  return {...actual,openSync:vi.fn(actual.openSync),writeFileSync:vi.fn(actual.writeFileSync),fsyncSync:vi.fn(actual.fsyncSync),
    renameSync:vi.fn(actual.renameSync),readFileSync:vi.fn(actual.readFileSync)};
});
let f:StateFixture;
const at = '2030-01-01T00:00:00.000Z';
const publish = (time=at, elapsed:number|null=0) => publishRunStatus(f.location,time,elapsed);
beforeEach(async () => {f=await stateFixture();await f.admit();});
afterEach(async () => {vi.restoreAllMocks();vi.resetAllMocks();await f.close();});
it('publishes the real current state with identity, prepared authority and host disclosure',async()=>{
  expect(RUN_STATUS_LAYOUT).toEqual({runsDirectory:'runs',fileName:'status.json'});
  const s=get(publish());expect(validStatus(s)).toBe(true);
  expect(s).toMatchObject({version:2,run:'Run',identity:f.launch.unit,journalCursor:5,statusSince:5,
    authority:f.scope.authority,
    host:{readiness:'applied'},
    notification:{session:'unbound'},attention:null});
  expect(s.notification).not.toHaveProperty('route');
});
it.each(['corrupt','future','contradictory','wrong_run'])('regenerates %s old bytes but the reader itself never rebuilds',kind=>{
  const initial=get(publish()),file=join(f.journal.root,'status.json');
  fs.writeFileSync(file,kind==='corrupt' ? '{' : JSON.stringify({...initial,...(kind==='future'?{version:3}
    :kind==='contradictory'?{stopReason:'completed'}:{run:'Foreign'})}));
  expect(readRunStatus(f.location)).toMatchObject({ok:false,kind:'invalid'});
  expect(publish()).toMatchObject({ok:true,value:{journalCursor:5}});
});
it('refuses a file ahead of restored state and clamps same-cursor clock rollback',()=>{
  const old=get(publish('2031-01-01T00:00:00.000Z'));
  expect(get(publish()).publishedAt).toBe(old.publishedAt);
  fs.writeFileSync(join(f.journal.root,'status.json'),JSON.stringify({...old,journalCursor:6}));
  expect(publish()).toMatchObject({ok:false,kind:'conflict'});
  expect(get(readRunStatus(f.location)).journalCursor).toBe(6);
});
it('never yields or borrows an active transaction, on the same or a second SQLite connection',async()=>{
  let timer=false;const scheduled=Promise.resolve().then(()=>{timer=true;});
  expect(publish()).not.toBeInstanceOf(Promise);expect(timer).toBe(false);await scheduled;
  expect(withState(f.database,true,()=>publish())).toMatchObject({ok:false,kind:'conflict'});
  const other=new DatabaseSync(f.database);other.exec('BEGIN IMMEDIATE');
  try {expect(publish()).toMatchObject({ok:false,kind:'conflict'});}finally{other.exec('ROLLBACK');other.close();}
  expect(publish().ok).toBe(true);
});
it('uses only indexed current rows at export and keeps the read transaction/WAL lifetime inside one synchronous call',()=>{
  const queries:string[]=[];const original=DatabaseSync.prototype.prepare;
  const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(sql:string){queries.push(sql);return original.call(this,sql);});
  try {expect(publish().ok).toBe(true);} finally {spy.mockRestore();}
  expect(queries.some(q=>/FROM events/i.test(q))).toBe(false);
  const db=new DatabaseSync(f.database);
  try {expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({busy:0});}finally{db.close();}
});
it('A11 renames under exclusion then fsyncs the published inode and directory after releasing it',async()=>{
  const actual=await vi.importActual<typeof import('node:fs')>('node:fs'),steps:string[]=[],fds=new Map<number,string>();
  vi.mocked(fs.openSync).mockImplementation(((...args:any[])=>{const fd=(actual.openSync as any)(...args);fds.set(fd,String(args[0]));return fd;}) as any);
  vi.mocked(fs.fsyncSync).mockImplementation(fd=>{steps.push(fds.get(fd)===f.journal.root?'directory':'file');
    expect(withState(f.database,true,()=>({ok:true,value:true}))).toMatchObject({ok:true});actual.fsyncSync(fd);});
  vi.mocked(fs.renameSync).mockImplementation((a,b)=>{steps.push('rename');expect(withState(f.database,true,()=>({ok:true,value:true}))).toMatchObject({ok:false,kind:'conflict'});actual.renameSync(a,b);});
  expect(publish().ok).toBe(true);expect(steps).toEqual(['rename','file','directory']);
});
it.each(['write','file_sync','rename','parent_sync','end'])('publication fault at %s cannot veto committed cancellation',async point=>{
  get(publish());
  await f.append(f.control,[{type:'control_intent',intent:{id:'cancel',kind:'cancel',run:'Run',unit:f.launch.unit,expectedCursor:5}}]);
  const actual=await vi.importActual<typeof import('node:fs')>('node:fs'),fds=new Map<number,string>();
  const fail=()=>{throw Object.assign(new Error('injected publication fault'),{code:'EIO'});};
  vi.mocked(fs.openSync).mockImplementation(((...args:any[])=>{const fd=(actual.openSync as any)(...args);fds.set(fd,String(args[0]));return fd;}) as any);
  vi.mocked(fs.writeFileSync).mockImplementation(((fd:any,...args:any[])=>{if(point==='write'&&typeof fd==='number'&&fds.get(fd)?.endsWith('.tmp'))fail();(actual.writeFileSync as any)(fd,...args);}) as any);
  vi.mocked(fs.fsyncSync).mockImplementation(fd=>{if(point==='file_sync'&&fds.get(fd)?.endsWith('.tmp')||point==='parent_sync'&&fds.get(fd)===f.journal.root)fail();actual.fsyncSync(fd);});
  if(point==='rename')vi.mocked(fs.renameSync).mockImplementationOnce(fail);
  const exec=DatabaseSync.prototype.exec;
  const end=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(sql:string){if(point==='end'&&sql==='COMMIT')fail();return exec.call(this,sql);});
  expect(publish()).toMatchObject({ok:false,kind:'unknown'});end.mockRestore();vi.restoreAllMocks();vi.resetAllMocks();
  expect((await f.projection()).status).toBe('cancelled');expect(get(publish()).status).toBe('cancelled');
  expect(fs.readdirSync(f.journal.root).filter(n=>n.endsWith('.tmp'))).toEqual([]);
});
it('reads unknown I/O honestly and refuses aliased carriers and invalid elapsed observations',async()=>{
  expect(publish(at,-1)).toMatchObject({ok:false,kind:'invalid'});get(publish());
  vi.mocked(fs.readFileSync).mockImplementationOnce(()=>{throw Object.assign(new Error('uncertain read'),{code:'EIO'});});
  expect(readRunStatus(f.location)).toMatchObject({ok:false,kind:'unknown'});
  fs.unlinkSync(join(f.journal.root,'status.json'));fs.symlinkSync('missing',join(f.journal.root,'status.json'));
  expect(readRunStatus(f.location)).toMatchObject({ok:false,kind:'invalid'});
});
it('changes statusSince only at the committed transition and exposes current step start/elapsed without a timeout',async()=>{
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
  const running=get(publish(new Date(Date.now()+1000).toISOString()));
  expect(running).toMatchObject({status:'running',statusSince:6,currentStage:'work'});expect(running.step.startedAt).not.toBeNull();
  expect(typeof running.step.elapsedMs).toBe('number');
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
  expect(get(publish()).statusSince).toBe(6);
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'quota'}}]);
  expect(get(publish())).toMatchObject({status:'parked',statusSince:8,attention:{reason:'attempt_failed',detail:'quota'}});
});

const children:ChildProcess[]=[];
afterEach(async()=>{await Promise.all(children.splice(0).map(child=>new Promise<void>(done=>{
  if(child.exitCode!==null||child.signalCode!==null){done();return;}
  child.once('close',()=>done());child.kill('SIGKILL');
})));});
function worker(options:Record<string,unknown>={}) {
  const child=spawn(process.execPath,[resolve('spec/native/fixtures/rewrite-export-worker.mjs'),JSON.stringify({location:f.location,writer:f.control,unit:f.launch.unit,cursor:5,...options})],{
    cwd:resolve('.'),env:{...process.env,HOME:f.root,FC_HOME:resolve(f.database,'..')},
    stdio:['pipe','pipe','pipe','ipc']});children.push(child);
  let stderr='';child.stderr!.on('data',b=>{stderr+=b;});
  const messages:any[]=[];const pending:{test:(m:any)=>boolean;done:(m:any)=>void;reject:(e:Error)=>void}[]=[];
  child.on('message',m=>{messages.push(m);for(const p of pending.splice(0))if(p.test(m))p.done(m);else pending.push(p);});
  const closed=new Promise<void>(done=>child.once('close',()=>{for(const p of pending)p.reject(new Error(stderr));done();}));
  const next=(test:(m:any)=>boolean)=>new Promise<any>((done,reject)=>{const found=messages.find(test);if(found)done(found);else pending.push({test,done,reject});});
  return {child,closed,attempting:()=>next(m=>m.attempting),barrier:(phase?:string)=>next(m=>m.barrier&&(!phase||m.phase===phase)),result:()=>next(m=>m.result),release:()=>child.stdin!.write('x')};
}
it('atomic readers observe only complete old or new files throughout replacement',async()=>{
  let old=get(publish());
  for(let replacement=0;replacement<8;replacement++) {
    await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
    const exporter=worker({boundary:'replace'});
    await exporter.barrier('before');
    // The independent writer has fully written the temp file and still owns the lock.
    expect(get(readRunStatus(f.location))).toEqual(old);
    exporter.release();await exporter.barrier('after');
    // Rename has happened, but the writer has not committed/released or fsynced.
    const next=get(readRunStatus(f.location));
    expect(next).toEqual({...old,journalCursor:old.journalCursor+1,status:'running',statusSince:6,
      currentStage:'work',step:next.step});
    expect(next.step.startedAt).not.toBeNull();
    expect(typeof next.step.elapsedMs).toBe('number');
    exporter.release();expect((await exporter.result()).result).toEqual({ok:true,value:next});
    await exporter.closed;
    expect(get(readRunStatus(f.location))).toEqual(next);old=next;
  }
});
it('P7 two exporters and a genuinely contending transition process preserve order without a second lock or retry scheduler',async()=>{
  get(publish());const first=worker({boundary:'sync'});await first.barrier();
  const contender=worker({action:'transition'}),second=worker();
  expect((await contender.result()).result).toMatchObject({ok:true});
  expect((await second.result()).result).toMatchObject({ok:true});
  first.release();expect((await first.result()).result.ok).toBe(true);
  await Promise.all([first.closed,second.closed,contender.closed]);
  const newer=get(publish('2031-01-01T00:00:00.000Z'));expect(newer).toMatchObject({journalCursor:6,status:'cancelled'});
  const refresh=worker();const answer=(await refresh.result()).result;expect(answer).toMatchObject({ok:true,value:{journalCursor:6,publishedAt:newer.publishedAt}});
  await refresh.closed;
});
it.each([false,true])('A11 SQLite busy handler waits for a short writer and returns conflict after its 5000 ms bound (long=%s)',async long=>{
  expect(withState(f.database,false,db=>({ok:true,value:db.prepare('PRAGMA busy_timeout').get()})))
    .toMatchObject({ok:true,value:{timeout:5000}});
  const holder=new DatabaseSync(f.database);holder.exec('BEGIN IMMEDIATE');
  try {
    const contender=worker({action:'transition'});await contender.attempting();
    if(!long) {await new Promise(r=>setTimeout(r,150));holder.exec('COMMIT');}
    const answer=(await contender.result()).result;
    expect(answer).toMatchObject(long?{ok:false,kind:'conflict'}:{ok:true});
    await contender.closed;
  } finally {if(long)holder.exec('ROLLBACK');holder.close();}
  expect(publish().ok).toBe(true);
});
it.each(['sync','rename','directory','end'])('P7 killed exporter at %s releases SQLite exclusion and never publishes uncommitted truth',async boundary=>{
  get(publish());const exporter=worker({boundary});await exporter.barrier();
  exporter.child.kill('SIGKILL');await exporter.closed;
  expect(get(publish()).journalCursor).toBe(5);
  const transition=worker({action:'transition'});expect((await transition.result()).result.ok).toBe(true);await transition.closed;
  expect(get(publish()).status).toBe('cancelled');
});

it.each([
  ['parked','backstop',3,0],['parked','backstop',1,4],['parked','attempt_failed',0,0],['parked','recovery_unknown',0,0],
  ['complete','completed',0,0],['accepted_blocked','accepted_blocked',0,0],
  ['incomplete','command_missing',0,0],['incomplete','command_nonzero',0,0],['incomplete','command_unfinished',0,0],
  ['incomplete','outputs_unpreserved',0,0],['failed','gate_irreparable',0,0],['failed','attempt_failed',0,0],
  ['failed','contract_refused',0,0],['failed','isolation_refused',0,0],['escalated','recovery_unknown',0,0],['cancelled','cancelled',0,0]
] as const)('emits notification-ready %s/%s without interpreting the detail prose',async(status,reason,gateSuffix,failureSuffix)=>{
  const {initialBackstop}=await import('../../dist-rewrite/contract/runtime.js');
  // Reconstruct is deliberately not used to invent an outcome: canonical suffixes enter through the real settlement batch.
  if(reason==='backstop') {
    const tree=await f.tree();
    const receipt:any={address:{run:'Run',stage:'gate',attempt:'Attempt',invocation:1},ending:'technical_failure',
      before:tree,after:tree,audit:f.ref,closure:'dead',usage:{state:'unknown',raw:[]},evidence:[],inputChars:0};
    await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'technical',address:{kind:'stage',...receipt.address}}},
      {type:'attempt_settled',receipt},{type:'outcome_settled',address:receipt.address,obligation:'Revision:1',completed:false,
        backstop:{...initialBackstop(),gateSuffix,failureSuffix}}]);
  }
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status,reason,detail:'Opaque raw provider/context diagnostic'}}]);
  const emitted=get(publish());expect(validStatus(emitted)).toBe(true);
  expect(emitted.attention).toMatchObject({reason,detail:'Opaque raw provider/context diagnostic'});
  expect(emitted.backstop.condition).toBe(reason==='backstop'?gateSuffix>=3?'gate':'failure':null);
  const corpus=join(f.root, 'status-corpus');fs.mkdirSync(corpus,{recursive:true});
  fs.writeFileSync(join(corpus,`${status}-${reason}-${gateSuffix}-${failureSuffix}.json`),JSON.stringify(emitted));
});
it.each(['accepted','accepted_blocked','rejected_repairable','rejected_irreparable'] as const)('emits authenticated progress/delivery %s, with no declared result labels, from current settlement rows',async outcome=>{
  const {progressPlan}=await import('../fixtures/rewrite-progress-gate.js');
  const plan={...progressPlan,stages:progressPlan.stages.map(s=>({...s,role:'author'}))};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Progress',plan,digest:'b'.repeat(64),executed:[]}}]);
  const tree=await f.tree();
  for(const stage of ['progress_gate','delivery_gate']) {
    const address={run:'Run',stage,attempt:'Attempt',invocation:1};
    const receipt:any={address,ending:'delivered',answer:{kind:'gate',answer:{outcome,reason:'opaque',criteria:{correct:{status:'pass',evidence:'bytes'}},
      findings:[],remainingWork:[]}},answerRef:f.ref,before:tree,after:tree,
      audit:f.ref,closure:'dead',usage:{state:'known',raw:[],input:1,costUsd:0.1},evidence:[],inputChars:10};
    await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...address}}},{type:'attempt_settled',receipt}]);
  }
  const emitted=get(publish());expect(emitted.gates).toMatchObject([{stage:'progress_gate',scope:'progress',outcome},
    {stage:'delivery_gate',scope:'delivery',outcome}]);expect(emitted.usage).toMatchObject({state:'known',input:2,costUsd:0.2});
  expect(validStatus(emitted)).toBe(true);const corpus=join(f.root, 'status-corpus');fs.mkdirSync(corpus,{recursive:true});
  fs.writeFileSync(join(corpus,'gates-'+outcome+'.json'),JSON.stringify(emitted));
});

it('DI17 a simulated boot change says interrupted by restart and supplies the exact resume command without changing domain facts', async () => {
  const f = await stateFixture();
  try {
    await f.admit();
    const owner = { ...f.execution.owner, boot: 'previous-boot' };
    await f.append(f.control, [{ type: 'run_observed', observation: { unit: f.launch.unit, state: 'active', owner,
      evidence: [], detail: 'Recorded prior supervisor boot' } }]);
    const before = await f.projection();
    const interrupted = get(publishRunStatus(f.location, new Date().toISOString(), null, 'current-boot'));
    expect(interrupted.status).toBe(before.status);
    expect(interrupted.attention?.detail).toContain('interrupted by restart');
    expect(interrupted.interruption).toEqual({ detail: 'interrupted by restart', resume: 'flowcrew resume Run' });
    expect((await f.projection()).cursor).toBe(before.cursor);
    expect(get(publishRunStatus(f.location, new Date().toISOString(), null, 'previous-boot')).interruption).toBeUndefined();
  } finally { await f.close(); }
});


it.each(['claim-unreleased','closure-unconfirmed'] as const)('keeps the %s park reason while status lists every current obligation in recording order', async firstKind => {
  const secondKind = firstKind === 'claim-unreleased' ? 'closure-unconfirmed' : 'claim-unreleased';
  const first = {kind:firstKind,detail:'Parking obligation',members:[]};
  const second = {kind:secondKind,detail:'Later blocking obligation',members:[]};
  const accounting = {kind:'accounting-unsettled' as const,detail:'Dead activation bookkeeping',members:[]};
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]},
    {type:'active_time_opened',interval:{id:'Open',owner:f.execution.owner,openedAt:at,spentMs:null}}]);
  await f.append(f.control,[{type:'obligation',open:true,obligation:first},
    {type:'obligation',open:true,obligation:second},{type:'obligation',open:true,obligation:accounting}]);
  const parkReason = firstKind === 'claim-unreleased' ? 'claim_unreleased' : 'closure_unconfirmed';
  expect(get(publish())).toMatchObject({status:'parked',stopReason:parkReason,
    attention:{reason:parkReason,obligations:[first,second,accounting]}});
  await f.append(f.control,[{type:'obligation',open:false,obligation:first}]);
  const laterReason = secondKind === 'claim-unreleased' ? 'claim_unreleased' : 'closure_unconfirmed';
  expect(get(publish())).toMatchObject({status:'parked',stopReason:parkReason,
    attention:{reason:laterReason,obligations:[second,accounting]}});
  await f.append(f.control,[{type:'obligation',open:true,obligation:first}]);
  expect(get(publish())).toMatchObject({status:'parked',stopReason:parkReason,
    attention:{reason:laterReason,obligations:[second,accounting,first]}});
  expect((await f.projection()).conclusion?.reason).toBe(parkReason);
});
