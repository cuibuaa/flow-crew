import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {stateFixture,get,type StateFixture} from '../fixtures/rewrite-state.js';
import {publishRunStatus,readRunStatus,refreshRunStatus} from '../../dist-rewrite/ops/status.js';
import {withState,recordHeldBytes,readEvents} from '../../dist-rewrite/records/state.js';
import {main} from '../../dist-rewrite/ops/main.js';
import * as host from '../../dist-rewrite/host/process.js';
import {validStatus} from '../../rewrite-src/contract/status.mjs';
import {currentStatus,withCurrentBoot} from '../../dist-rewrite/contract/status.mjs';
let f:StateFixture;
const at = '2030-01-01T00:00:00.000Z';
const publish = (time=at, elapsed:number|null=0) => publishRunStatus(f.location,time,elapsed);
beforeEach(async () => {f=await stateFixture();await f.admit();});
afterEach(async () => {vi.restoreAllMocks();vi.resetAllMocks();await f.close();});
it('cancel consumes the request decoded from a historical store and publishes heldBytes',async()=>{
  const root=join(f.root,'historical'),storeRoot=join(root,'store'),home=join(root,'state'),database=join(home,'state.sqlite');
  fs.mkdirSync(home,{recursive:true});
  fs.copyFileSync(new URL('../fixtures/old-journal/state.sqlite',import.meta.url),database);
  const db=new DatabaseSync(database);
  db.exec('PRAGMA foreign_keys=OFF');
  let run:string;
  try {
    const row=db.prepare('SELECT root,store,name,current FROM runs').get()!;run=String(row.name);
    const prefix=String(row.store).slice(0,String(row.store).lastIndexOf('/'));
    // Only the copied fixture's addresses move; all historical lifecycle/measurement facts remain intact.
    for(const [table,columns] of Object.entries({runs:['root','store','current'],events:['root','payload'],
      current_rows:['root','value'],epochs:['root'],advisory_activity:['root'],resources:['id','holder','path']}))
      for(const column of columns)db.prepare(`UPDATE ${table} SET ${column}=replace(${column},?,?)`).run(prefix,root);
    const value=JSON.parse(String(db.prepare('SELECT current FROM runs').get()!.current));
    expect(value.timeline.endedAt).toBeDefined();expect(value.heldSpace).toBeUndefined();
    fs.mkdirSync(value.launch.project,{recursive:true});fs.writeFileSync(join(value.launch.project,'retained'),'historical retained work');
    fs.mkdirSync(join(storeRoot,'runs',run),{recursive:true});
  } finally {db.close();}
  const location={storeRoot,database,run},pending=get(await refreshRunStatus(location,at));
  expect(pending.heldSpacePending).toBe(true);expect(pending.heldBytes).toBeUndefined();
  let stdout='',stderr='';
  const exit=await main(['cancel',run],{cwd:root,storeRoot,home,runtimeRoot:root,environment:{PATH:process.env.PATH!},
    stdin:new Uint8Array(),abort:new AbortController().signal,stdout:async b=>{stdout+=Buffer.from(b);},stderr:async b=>{stderr+=Buffer.from(b);}});
  expect(exit,stderr+stdout).toBe(0);
  const published=get(readRunStatus(location));expect(published.heldSpacePending).toBeUndefined();expect(published.heldBytes).toBeGreaterThan(0);
  const stored=new DatabaseSync(database);
  try {const value=JSON.parse(String(stored.prepare('SELECT current FROM runs').get()!.current));
    expect(value.heldSpace).toMatchObject({ending:pending.statusSince,bytes:published.heldBytes});}
  finally {stored.close();}
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
  const recordedAt=(await f.projection()).timeline!.lastActivityAt;
  const emitted=get(publish());expect(validStatus(emitted)).toBe(true);
  expect(emitted.backstop.pausedAt).toBe(reason==='backstop'?recordedAt:undefined);
  expect(get(publish('2031-01-01T00:00:00.000Z')).backstop.pausedAt).toBe(emitted.backstop.pausedAt);
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
    const owner = f.execution.owner;
    await f.append(f.control, [{ type: 'run_observed', observation: { unit: f.launch.unit, state: 'active', owner,
      evidence: [], detail: 'Recorded prior supervisor boot' } }]);
    const before = await f.projection();
    const interrupted = get(await refreshRunStatus(f.location, new Date().toISOString(), 'current-boot'));
    expect(interrupted.status).toBe('interrupted');expect(interrupted.journalStatus).toBe(before.status);
    expect(interrupted.attention?.detail).toContain('interrupted by restart');
    expect(interrupted.interruption).toEqual({ detail: 'interrupted by restart', resume: 'flowcrew resume Run' });
    expect((await f.projection()).cursor).toBe(before.cursor);
    expect(get(await refreshRunStatus(f.location, new Date().toISOString(), owner.boot)).interruption).toBeUndefined();
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

it('observes the published activation after publication instead of persisting an earlier native observation',async()=>{
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'First activation'}}]);
  const first=get(publish());
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.control.owner,evidence:[],detail:'New activation'}}]);
  const next=get(publish());
  expect(first.host.activation?.owner).toEqual(f.execution.owner);
  expect(next.host.activation).toMatchObject({owner:f.control.owner,state:'active',checkedAt:null});
  const {observeStatus}=await import('../../dist-rewrite/host/process.js');
  const live=await observeStatus(next,f.control.owner.boot);
  expect(live).toMatchObject({status:'running',journalStatus:'running',currentStage:'work',focus:'work'});
  expect(live.stages?.find(stage=>stage.id==='work')?.state).toBe('running');
  expect(get(readRunStatus(f.location))).toEqual(next);
});

it('publishes every current stage and each replaced definition once with attempts, verdict and park attention',async()=>{
  const work = f.plan.stages[0], gate = {...f.plan.stages[1],repair:undefined};
  const old = {...work,id:'old_suffix',after:['gate'],instruction:'Old pending work'};
  const finish = {...gate,id:'finish',after:['old_suffix']};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Expanded',plan:{stages:[work,gate,old,finish]},digest:'b'.repeat(64),executed:[]}}]);
  const tree=await f.tree();
  const receipt=(stage:string,ending='delivered',invocation=1):any=>({address:{run:'Run',stage,attempt:stage+'_attempt',invocation},ending,
    before:tree,after:tree,audit:f.ref,closure:'dead',usage:{state:'unknown',raw:[]},evidence:[],inputChars:0});
  for(const stage of ['work','gate']) {
    const r=receipt(stage);
    if(stage==='gate')Object.assign(r,{answer:{kind:'gate',answer:{outcome:'accepted',reason:'Measured review',
      criteria:{correct:{status:'pass',evidence:'Synthetic evidence'}},findings:[],remainingWork:[]}},answerRef:f.ref});
    await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...r.address}}},
      {type:'attempt_settled',receipt:r},{type:'stage_settled',stage,state:'settled',evidence:[]}]);
  }
  const follow={...work,id:'follow',after:['gate'],instruction:'New work\nFull operator instruction'};
  const final={...finish,after:['follow']};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Replacement',plan:{stages:[work,gate,follow,final]},digest:'c'.repeat(64),executed:[]}}]);
  // Repeated unchanged plans cannot duplicate the retired suffix.
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Current',plan:{stages:[work,gate,follow,final]},digest:'d'.repeat(64),executed:[]}}]);
  const first=receipt('follow','invalid_answer');
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'Live stage focus'}}]);
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...first.address}}},
    {type:'attempt_settled',receipt:first},{type:'stage_settled',stage:'follow',state:'pending',evidence:[]}]);
  const correcting=currentStatus(get(publish()));
  expect(correcting).toMatchObject({currentStage:null,focus:'follow',step:{label:null}});
  expect(correcting.stages?.find(s=>s.id==='follow')).toMatchObject({state:'needs-correction',attempts:1,lastEnding:'invalid_answer'});
  const correction=receipt('follow','invalid_answer',2);
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'correction',address:{kind:'stage',...correction.address}}},
    {type:'attempt_settled',receipt:correction},{type:'stage_settled',stage:'follow',state:'pending',evidence:[]},
    {type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Inspect retained attempt'}}]);
  const status=currentStatus(get(publish()));
  expect(status.currentStage).toBeNull();expect(status.focus).toBe('follow');
  expect(status.step.label).toBeNull();
  expect(status.stages?.slice(0,4).map(s=>[s.id,s.state])).toEqual([['work','settled'],['gate','settled'],['follow','parked'],['finish','pending']]);
  expect(status.stages?.find(s=>s.id==='gate')).toMatchObject({attempts:1,lastEnding:'delivered',verdict:'accepted',startedAt:expect.any(String),settledAt:expect.any(String)});
  expect(status.stages?.find(s=>s.id==='follow')).toMatchObject({purpose:'work',role:'author',after:['gate'],goal:'New work',instruction:'New work\nFull operator instruction',commands:[],attempts:1,lastEnding:'invalid_answer',startedAt:expect.any(String),settledAt:null});
  // Replacement retains the definition's last own recorded state; it does not invent an execution skip.
  expect(status.stages?.filter(s=>s.id==='old_suffix')).toEqual([expect.objectContaining({state:'pending',replacedBy:'Replacement',revision:'Expanded',attempts:0})]);
  expect(status.stages?.filter(s=>s.id==='finish'&&s.replacedBy)).toEqual([expect.objectContaining({replacedBy:'Replacement',after:['old_suffix']})]);
  expect(status.stages?.find(s=>s.id==='repair')).toMatchObject({replacedBy:'Expanded'});
  expect(status.plan).toEqual({revision:'Current',pending:{stages:[follow,final]}});
  expect(currentStatus(get(readRunStatus(f.location)))).toEqual(status);
});


it.each(['active','inactive','unknown','failed'] as const)('keeps correction focus with %s controller/lifecycle facts',async mode=>{
  const tree=await f.tree(),address={run:'Run',stage:'work',attempt:'Correction',invocation:1};
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...address}}},
    {type:'attempt_settled',receipt:{address,ending:'invalid_answer',before:tree,after:tree,audit:f.ref,
      closure:'dead',usage:{state:'unknown',raw:[]},evidence:[],inputChars:0}},
    {type:'stage_settled',stage:'work',state:'pending',evidence:[]}]);
  if(mode==='failed') await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained correction'}}]);
  else await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:mode,
    owner:mode==='active'?f.execution.owner:null,evidence:[],detail:'Controller fixture'}}]);
  const raw=get(publish()),snapshot=currentStatus(raw);
  expect(snapshot).toMatchObject({status:mode==='active'?'running':mode==='inactive'?'interrupted':mode,
    currentStage:null,focus:'work',step:{label:null}});
  expect(snapshot.stages!.find(stage=>stage.id==='work')).toMatchObject({state:'needs-correction',attempts:1});
  expect(validStatus(raw)).toBe(true);
  expect(get(readRunStatus(f.location))).toEqual(raw);
});

it('decodes additive stage/plan metadata and historical files without it at the canonical boundary',()=>{
  const emitted=get(publish());
  expect(emitted.stages?.length).toBe(3);
  expect(validStatus({...emitted,stages:[{...emitted.stages![0],state:'unrecognized'}]})).toBe(false);
  expect(validStatus({...emitted,stages:[{...emitted.stages![0],state:'dormant'}]})).toBe(true);
  const segment={kind:'attempt' as const,attempt:'A',invocation:1,startedAt:null,endedAt:null};
  expect(validStatus({...emitted,stages:[{...emitted.stages![0],segments:[{...segment,ending:'invalid_answer'}]}]})).toBe(true);
  expect(validStatus({...emitted,stages:[{...emitted.stages![0],segments:[{...segment,ending:'unrecognized'}]}]})).toBe(false);
  expect(validStatus({...emitted,plan:{...emitted.plan,pending:{stages:[{id:'MissingDefinition'}]}}})).toBe(false);
  const {stages,plan,...legacy}=emitted;
  expect(validStatus(legacy)).toBe(true);
  const {title,checkpoints,activity,guidance,briefDigest,sourceProject,...historical}=legacy;
  expect(validStatus({...historical,version:2,host:{...historical.host,readiness:'applied'}})).toBe(true);
});


it('publishes definition-local segments, refused continuations, pause, guide/resume and verbatim summaries from projection only',async()=>{
  const tree=await f.tree();
  const receipt=(invocation:number,ending:string):any=>({address:{run:'Run',stage:'work',attempt:'OneAttempt',invocation},ending,
    answer:{kind:'work',answer:{status:'delivered',summary:'Exact stage summary <verbatim>',caveats:[],remainingWork:[],blocks:null}},
    answerRef:f.ref,before:tree,after:tree,audit:f.ref,closure:'dead',usage:{state:'known',raw:[],input:100,cached:80,output:7},evidence:[],inputChars:1});
  const one=receipt(1,'invalid_answer');
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...one.address}}},
    {type:'attempt_settled',receipt:one},{type:'stage_settled',stage:'work',state:'pending',evidence:[]},
    {type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Engine message, untouched.'}}]);
  const parkedRaw=get(publish()),paused=currentStatus(parkedRaw),row=paused.stages!.find(s=>s.id==='work')!;
  expect(paused.currentStage).toBeNull();expect(paused.focus).toBe('work');
  expect(parkedRaw.stages![0].state).toBe('pending');
  expect(withCurrentBoot({...parkedRaw,host:{...parkedRaw.host,boot:'previous-boot'}},'current-boot').stages![0].state).toBe('parked');
  expect(row).toMatchObject({state:'parked',attempts:1,summary:'Exact stage summary <verbatim>',segments:[
    {kind:'attempt',attempt:'OneAttempt',invocation:1,ending:'invalid_answer',startedAt:expect.any(String),endedAt:expect.any(String)},
    {kind:'pause',startedAt:expect.any(String),endedAt:null}]});
  const base={run:'Run',unit:f.launch.unit,expectedCursor:(await f.projection()).cursor};
  await f.append(f.control,[{type:'control_intent',intent:{...base,id:'Guide',kind:'guide',intervention:{kind:'guide',address:null,content:f.ref}}},
    {type:'plan_committed',plan:{revision:'Guided',plan:f.plan,digest:'e'.repeat(64),executed:[]}},
    {type:'control_intent',intent:{...base,id:'Resume',kind:'resume'}}]);
  const two=receipt(2,'delivered');
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'continuation',address:{kind:'stage',...two.address}}},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'Live continuation'}}]);
  const continued=get(publish());
  expect(continued).toMatchObject({currentStage:'work',step:{label:'author · attempt 1 · continuation 2'}});
  expect(continued.stages!.find(s=>s.id==='work')).toMatchObject({state:'running',attempts:1});
  await f.append(f.execution,[{type:'attempt_settled',receipt:two},{type:'stage_settled',stage:'work',state:'settled',evidence:[]}]);
  const settled=get(publish());
  expect(settled.currentStage).toBeNull();
  expect(settled.stages!.find(s=>s.id==='work')!.segments!.map(part=>part.kind)).toEqual(['attempt','pause','attempt']);
  const changed={...f.plan.stages[0],instruction:'A different definition'};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Replacement',plan:{stages:[changed,...f.plan.stages.slice(1)]},digest:'f'.repeat(64),executed:[]}}]);
  const emitted=get(publish()),replaced=emitted.stages!.find(s=>s.id==='work'&&s.replacedBy)!;
  expect(replaced).toMatchObject({revision:'Revision',replacedBy:'Replacement',state:'settled',attempts:1,lastEnding:'delivered',summary:'Exact stage summary <verbatim>'});
  expect(replaced.segments).toHaveLength(3);expect(replaced.segments![1]).toMatchObject({kind:'pause',endedAt:expect.any(String)});
  expect(emitted.stages!.find(s=>s.id==='work'&&!s.replacedBy)).toMatchObject({attempts:0,lastEnding:null,startedAt:null,settledAt:null,segments:[]});
  expect(emitted.usage).toMatchObject({input:200,cached:160,output:14});
  expect(emitted).toMatchObject({startedAt:expect.any(String),lastActivityAt:expect.any(String)});
  expect((await f.projection()).timeline?.stages).toHaveLength(4);
  expect(get(readRunStatus(f.location))).toEqual(emitted);
  const {parseRunStatusFile}=await import('../../dist-rewrite/contract/runtime.js');
  const {valid}=await import('../../dist-rewrite/flowcrew-session.mjs');
  const {startedAt,lastActivityAt,endedAt,stages,...legacy}=emitted;
  for(const value of [emitted,{...legacy,stages:stages?.map(({segments,summary,commandProgress,...stage})=>stage)}]) {
    expect(parseRunStatusFile(value).ok).toBe(true);expect(valid(currentStatus(value))).toBe(true);
  }
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',
    run:'Run',stage:'work',attempt:'ReplacementAttempt',invocation:1}}}]);
  const replacement=get(publish());
  expect(replacement.step.label).toBe('author · attempt 1');
  expect(replacement.stages!.find(s=>s.id==='work'&&!s.replacedBy)!.attempts).toBe(1);
});

it('publishes old projection outcomes and measured pauses without replay or fabricated try times',async()=>{
  const tree=await f.tree(),address={run:'Run',stage:'work',attempt:'One',invocation:1};
  const interval={id:'First',owner:f.execution.owner,openedAt:'2026-11-18T10:00:00Z',spentMs:null};
  await f.append(f.execution,[{type:'active_time_opened',interval},
    {type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...address}}},
    {type:'attempt_settled',receipt:{address,ending:'invalid_answer',
      before:tree,after:tree,audit:f.ref,closure:'dead',usage:{state:'unknown',raw:[]},evidence:[],inputChars:0}},
    {type:'active_time_closed',interval:'First',spentMs:60_000},
    {type:'active_time_opened',interval:{...interval,id:'Second',openedAt:'2026-11-18T10:18:00Z'}},
    {type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Recorded refusal'}}]);
  // Reproduce the persisted pre-D1 format, leaving every existing projection fact untouched.
  get(withState(f.database,true,db=>{
    db.prepare("UPDATE runs SET current=json_remove(current,'$.timeline') WHERE root=?").run(f.journal.root);
    return {ok:true,value:true};
  }));
  const queries:string[]=[],prepare=DatabaseSync.prototype.prepare;
  const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(sql:string){queries.push(sql);return prepare.call(this,sql);});
  let snapshot:ReturnType<typeof publish>;
  try {snapshot=publish();} finally {spy.mockRestore();}
  expect(queries.filter(q=>/\bevents\b/i.test(q))).toEqual([]);
  const emitted=get(snapshot!);
  expect(emitted.stages!.find(s=>s.id==='work')).toMatchObject({attempts:1,lastEnding:'invalid_answer',segments:[
    {kind:'attempt',attempt:'One',invocation:1,ending:'invalid_answer',startedAt:null,endedAt:null},
    {kind:'pause',startedAt:'2026-11-18T10:01:00.000Z',endedAt:'2026-11-18T10:18:00Z'}]});
  expect(emitted.startedAt).toBeUndefined();expect(validStatus(emitted)).toBe(true);
  expect(get(readRunStatus(f.location))).toEqual(emitted);
  // A normal append begins retaining new times; it must not erase older projected outcomes or gaps.
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Recorded observation'}}]);
  expect((await f.projection()).timeline).toBeDefined();
  expect(get(publish()).stages!.find(s=>s.id==='work')!.segments).toEqual(emitted.stages!.find(s=>s.id==='work')!.segments);
});

it('a dead controller is read as interrupted for both run and stage without a current marker',async()=>{
  const owner={...f.execution.owner,pid:2147483647,group:2147483647};
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner,evidence:[],detail:'Dead controller fixture'}}]);
  get(publish()); // The producer publishes; observation below is read-only.
  const {refreshRunStatus}=await import('../../dist-rewrite/ops/status.js');
  const snapshot=get(await refreshRunStatus(f.location,new Date().toISOString(),owner.boot));
  expect(snapshot).toMatchObject({status:'interrupted',currentStage:null,step:{label:null,startedAt:null}});
  expect(snapshot.stages!.find(s=>s.id==='work')!.state).toBe('interrupted');
  expect(snapshot.stages!.some(s=>s.state==='running')).toBe(false);
  expect(get(readRunStatus(f.location))).toMatchObject({status:'running',currentStage:'work',focus:'work',stages:[expect.objectContaining({id:'work',state:'running'}),expect.anything(),expect.anything()]});
});

it('publishes a running gate command ledger from its addressed reservations and receipts',async()=>{
  const plan={...f.plan,stages:f.plan.stages.map(stage=>stage.id==='gate'?{...stage,commands:['Pass','Now','Later']}:stage)};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Checks',plan,digest:'9'.repeat(64),executed:[]}}]);
  const address={kind:'stage' as const,run:'Run',stage:'gate',attempt:'GateAttempt',invocation:1};
  const pass={tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)};
  const now={...pass,context:'d'.repeat(64)};
  const invocation={charge:'command' as const,address};
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address}},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'Live fixture controller'}},
    {type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{key:pass,identity:'Pass',invocation,state:'reserved'}},
    {type:'command',receipt:{key:pass,command:'Pass',execution:{state:'complete',exit:0},stdout:f.ref,stderr:f.ref,
      before:pass.tree,after:pass.tree,observed:{before:[],after:[]},delta:f.ref,spent:{durationMs:1}}},
    {type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{key:now,identity:'Now',invocation,state:'reserved'}}]);
  expect(get(publish()).stages!.find(stage=>stage.id==='gate')).toMatchObject({state:'running',attempts:1,commandProgress:[
    {command:'Pass',state:'passed'},{command:'Now',state:'running'},{command:'Later',state:'not_started'}]});
});

// The gate's commands run before its own invocation exists, so the previous stage's attempt is the last model invocation, and all
// commands of one attempt share one invocation address: status names the open reservation, and the gate's own attempt.
it('shows the running gate command and the gate\'s own command progress while the gate has no invocation of its own yet',async()=>{
  const plan={...f.plan,stages:f.plan.stages.map(stage=>stage.id==='gate'?{...stage,commands:['Pass','Now','Later']}:stage)};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Checks',plan,digest:'9'.repeat(64),executed:[]}}]);
  const authored={kind:'stage' as const,run:'Run',stage:'work',attempt:'WorkAttempt',invocation:1};
  const address={kind:'stage' as const,run:'Run',stage:'gate',attempt:'GateAttempt',invocation:1};
  const pass={tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)};
  const now={...pass,context:'d'.repeat(64)};
  const invocation={charge:'command' as const,address};
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:authored}},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'Live fixture controller'}},
    {type:'stage_settled',stage:'gate',state:'running',evidence:[]},
    {type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{key:pass,identity:'Pass',invocation,state:'reserved'}},
    {type:'command',receipt:{key:pass,command:'Pass',execution:{state:'complete',exit:0},stdout:f.ref,stderr:f.ref,
      before:pass.tree,after:pass.tree,delta:f.ref,spent:{durationMs:1}}},
    {type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{key:now,identity:'Now',invocation,state:'reserved'}}]);
  const published=get(publish());
  expect(published.step.label).toBe('Command Now');
  expect(published.stages!.find(stage=>stage.id==='gate')!.commandProgress).toEqual([
    {command:'Pass',state:'passed'},{command:'Now',state:'running'},{command:'Later',state:'not_started'}]);
});

it('publishes how each failed required command stands against the base tree',async()=>{
  const plan={...f.plan,stages:f.plan.stages.map(stage=>stage.id==='gate'?{...stage,commands:['Old','New','Quiet','Failed']}:stage)};
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Checks',plan,digest:'9'.repeat(64),executed:[]}}]);
  const address={kind:'stage' as const,run:'Run',stage:'gate',attempt:'GateAttempt',invocation:1};
  const invocation={charge:'command' as const,address};
  const key=(context:string)=>({tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:context.repeat(64)});
  const receipt=(command:string,context:string,exit:number,base?:number|{kind:string;detail:string})=>({key:key(context),command,execution:{state:'complete' as const,exit},
    stdout:f.ref,stderr:f.ref,before:'a'.repeat(64),after:'a'.repeat(64),delta:f.ref,spent:{durationMs:1},
    ...(base===undefined?{}:{base:typeof base==='number'?{tree:'0'.repeat(64),ok:true as const,execution:{state:'complete' as const,exit:base},stdout:f.ref,stderr:f.ref,spent:{durationMs:1}}
      :{tree:'0'.repeat(64),ok:false as const,...base}})});
  const records=[receipt('Old','c',3,3),receipt('New','d',3,0),receipt('Quiet','e',3),receipt('Failed','f',3,{kind:'not_placed',detail:'unavailable: copy refused'})];
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address}},
    {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.execution.owner,evidence:[],detail:'Live fixture controller'}},
    ...records.flatMap(item=>[{type:'invocation_reserved' as const,invocation},
      {type:'command_reserved' as const,reservation:{key:item.key,identity:item.command,invocation,state:'reserved' as const}},
      {type:'command' as const,receipt:item}])]);
  const published=get(publish());
  expect(validStatus(published)).toBe(true);
  expect(published.stages!.find(stage=>stage.id==='gate')!.commandProgress).toEqual([
    {command:'Old',state:'failed',basis:'pre-existing'},{command:'New',state:'failed',basis:'introduced'},{command:'Quiet',state:'failed'},{command:'Failed',state:'failed',basis:'introduced'}]);
});


it.each([
  [{title:'Declared run',body:'# Heading\n'},'Declared run'],
  [{body:'Intro prose.\n## A subsection\n# First heading\n# Second heading\n'},'First heading'],
  [{body:'A prose name is not a title.\n## Subheading'},undefined],
] as const)('publishes the brief title from its declared source (%j)',async(patch,title)=>{
  await f.close();f=await stateFixture(patch);await f.admit();
  const snapshot=get(publish());
  if(title===undefined)expect(snapshot).not.toHaveProperty('title');
  else expect(snapshot.title).toBe(title);
  expect(get(readRunStatus(f.location))).toEqual(snapshot);
});

it('publishes safe checkpoint records and their save time independently of publication or later activity',async()=>{
  const {captureCheckpoint,settleFrozenInputs}=await import('../../dist-rewrite/records/content.js');
  const checkpoint=get(await captureCheckpoint(f.scope,{run:'Run',stage:'work',attempt:'Checkpoint',invocation:1},null,'safe',[],get(await settleFrozenInputs(f.scope)).inputs));
  const empty=get(publish()).checkpoints;
  expect(empty).toEqual({count:0,latestAt:null});
  await f.append(f.execution,[{type:'checkpoint',checkpoint}]);
  const savedAt=(await f.projection()).timeline!.lastActivityAt;
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Later observation'}}]);
  expect(get(publish('2031-01-01T00:00:00.000Z')).checkpoints).toEqual({count:1,latestAt:savedAt});
  const quarantined=get(await captureCheckpoint(f.scope,{run:'Run',stage:'work',attempt:'Checkpoint',invocation:2},checkpoint.id,'quarantined',[],get(await settleFrozenInputs(f.scope)).inputs));
  await f.append(f.execution,[{type:'checkpoint',checkpoint:quarantined}]);
  expect(get(publish()).checkpoints).toEqual({count:1,latestAt:savedAt});
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(f.location.database);
  try { db.prepare("UPDATE runs SET current=json_remove(current,'$.timeline.checkpoints') WHERE root=?").run(f.journal.root); }
  finally { db.close(); }
  expect(get(publish()).checkpoints).toBeUndefined();
});


it('two concurrent status readers share WAL snapshots while a writer commits', async () => {
  const writer = new DatabaseSync(f.location.database);
  const before = get(await refreshRunStatus(f.location, at));
  const workers: Worker[] = [], barriers: Int32Array[] = [];
  try {
    writer.exec('BEGIN IMMEDIATE');
    const reads = [0, 1].map(() => {
      const barrier = new Int32Array(new SharedArrayBuffer(4)); barriers.push(barrier);
      const worker = new Worker(`
        const {parentPort, workerData} = require('node:worker_threads');
        const {DatabaseSync} = require('node:sqlite');
        const execute = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          execute.call(this, sql);
          if (sql === 'BEGIN') {
            this.prepare('SELECT current FROM runs').all();
            parentPort.postMessage({reading:true});
            Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
          }
        };
        import(workerData.module).then(async ({refreshRunStatus}) => {
          parentPort.postMessage({result:await refreshRunStatus(workerData.location, workerData.at)});
        }).catch(error => {throw error;});
      `, { eval: true, workerData: { barrier: barrier.buffer, location: f.location, at,
        module: new URL('../../dist-rewrite/ops/status.js', import.meta.url).href } });
      workers.push(worker);
      let ready = false;
      const reading = new Promise<void>((resolve, reject) => {
        worker.on('message', message => {
          if (message.reading) { ready = true; resolve(); }
          else if (!ready) {
            try { expect(ready, 'status must read while the writer holds BEGIN IMMEDIATE: ' + JSON.stringify(message)).toBe(true); }
            catch (error) { reject(error); }
          }
        });
        worker.on('error', reject);
        worker.on('exit', () => { if (!ready) reject(Error('reader exited before its snapshot')); });
      });
      const result = new Promise<Awaited<ReturnType<typeof refreshRunStatus>>>((resolve, reject) => {
        worker.on('message', message => { if (message.result) resolve(message.result); });
        worker.on('error', reject);
      });
      return { reading, result };
    });
    // Both read transactions overlap each other and the reserved writer, with no elapsed-time heuristic.
    await Promise.all(reads.map(read => read.reading));
    writer.prepare("UPDATE runs SET current=json_set(current,'$.heldSpace',json(?)) WHERE root=?")
      .run(JSON.stringify({ending:1,bytes:4321}),f.journal.root);
    writer.exec('COMMIT'); // WAL writers can commit while both snapshots are still held.
    for (const barrier of barriers) { Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0); }
    for (const read of reads) expect(get(await read.result).heldBytes).toBe(before.heldBytes);
    expect(get(await refreshRunStatus(f.location, at)).heldBytes).toBe(4321);
  } finally {
    for (const barrier of barriers) { Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0); }
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});

it.each(['natural','cancel'] as const)('%s ending measures under the right writer outside transactions and reexports after loss',async mode=>{
  const walk=vi.spyOn(host,'runOperation');
  await recordHeldBytes(f.execution);
  expect(walk).not.toHaveBeenCalled();
  if(mode==='natural')await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'ended'}}]);
  else await f.append(f.control,[{type:'control_intent',intent:{id:'Cancel',kind:'cancel',run:'Run',unit:f.launch.unit,expectedCursor:(await f.projection()).cursor}}]);
  const readWalk=vi.spyOn(fs,'readdirSync').mockImplementation(()=>{throw Error('Status walked retained directories');});syncBuiltinESMExports();
  try {expect(get(await refreshRunStatus(f.location,at))).toMatchObject({status:mode==='natural'?'failed':'cancelled',heldSpacePending:true});expect(get(publish()).heldBytes).toBeUndefined();}
  finally {readWalk.mockRestore();syncBuiltinESMExports();}
  const writer=mode==='natural'?f.execution:f.control;
  if(mode==='cancel'){await recordHeldBytes(f.execution);expect(walk).not.toHaveBeenCalled();}
  walk.mockResolvedValueOnce({ok:false,kind:'unavailable',detail:'Unreadable'});
  await recordHeldBytes(writer); expect(get(publish())).toMatchObject({heldSpacePending:true});
  let unblock!:()=>void, ready!:()=>void;
  const gate=new Promise<void>(resolve=>{unblock=resolve;}), entered=new Promise<void>(resolve=>{ready=resolve;});
  // Only transport is authored: pause after the real walk has read its first inode.
  const lstat=fs.promises.lstat;
  const scan=vi.spyOn(fs.promises,'lstat').mockImplementationOnce(async(...args)=>{
    const info=await lstat(...args);ready();await gate;return info;
  });syncBuiltinESMExports();
  walk.mockImplementationOnce(request=>host.performOperation(request));
  const measuring=recordHeldBytes(writer);
  try {
    await entered;
    await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Same installation writes during measurement'}}]);
    unblock(); await measuring;
  } finally {unblock();await measuring;scan.mockRestore();syncBuiltinESMExports();walk.mockRestore();}
  const saved=get(publish()); expect(saved.heldBytes).toBeGreaterThan(0); expect(saved.heldSpacePending).toBeUndefined();
  const history=get(await readEvents(f.journal,0));
  await fs.promises.unlink(join(f.journal.root,'status.json'));
  const forbidden=vi.spyOn(host,'runOperation').mockRejectedValue(Error('Must reuse measurement'));
  await recordHeldBytes(f.control);
  expect(get(await refreshRunStatus(f.location,at)).heldBytes).toBe(saved.heldBytes);
  expect(get(publish()).heldBytes).toBe(saved.heldBytes);
  expect(forbidden).not.toHaveBeenCalled();
  expect(get(await readEvents(f.journal,0))).toEqual(history);
});

it('held accounting deduplicates overlapping roots and hard links and never traverses symlinks',async()=>{
  const {heldBytes}=await import('../../dist-rewrite/records/held.js');
  const store=join(f.root,'held'),work=join(store,'work','Held'),project=join(work,'project');
  const pin=join(store,'pins','Held'),record=join(store,'runs','Held'),outside=join(f.root,'outside-held');
  for(const path of [project,pin,record,outside])await fs.promises.mkdir(path,{recursive:true});
  await fs.promises.writeFile(join(project,'one'),'12345');
  await fs.promises.link(join(project,'one'),join(pin,'same-inode'));
  await fs.promises.writeFile(join(record,'raw'),'123');
  await fs.promises.writeFile(join(record,'status.json'),'excluded');
  await fs.promises.writeFile(join(record,'controller.sqlite'),'excluded lock identity');
  await fs.promises.writeFile(join(outside,'foreign'),'not retained');
  const link=join(work,'link');await fs.promises.symlink(outside,link);
  const paths={project,runtime:{path:'pins/Held/.pin'}};
  expect(await heldBytes(store,'Held',paths)).toBe(8+(await fs.promises.lstat(link)).size);
  await fs.promises.rm(pin,{recursive:true});
  expect(await heldBytes(store,'Held',paths)).toBe(8+(await fs.promises.lstat(link)).size);
});
