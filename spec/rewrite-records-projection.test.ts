import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendEvents, readEvents, listProjections, openJournal, readProjection, statusView, withState } from '../dist-rewrite/records/state.js';
let f: SqlFixture;
beforeEach(async () => { f = await sqlFixture(); });
afterEach(async () => { await f.close(); });
it('pre-admission state is unavailable and discovered as an explicit failure', async () => {
  expect(await readProjection(f.journal)).toMatchObject({ ok: false, kind: 'unavailable' });
  expect(get(await listProjections(f.location.storeRoot, f.database))).toHaveLength(1);
  expect(get(await listProjections(f.location.storeRoot, f.database))[0].projection).toMatchObject({ ok: false, kind: 'unavailable' });
});
it('reads admitted current rows with independent initial stage states', async () => {
  await f.admit();
  expect(await f.projection()).toMatchObject({ status: 'pending', statusSince: 5, currentStage: null, cursor: 5, restoring: null });
  expect((await f.projection()).stageStates.slice().sort((a, b) => a.stage.localeCompare(b.stage))).toEqual([{ stage: 'gate',
   state: 'pending', obligation: 'Revision:1', completed: false }, { stage: 'repair', state: 'dormant', obligation: 'Revision:2',
   completed: false }, { stage: 'work', state: 'pending', obligation: 'Revision:0', completed: false }]);
});
it('keeps statusSince at the batch that changed status through reads and irrelevant observations', async () => {
  await f.admit();
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', run: 'Run',
   stage: 'work', attempt: 'Attempt', invocation: 1 } } }]);
  expect((await f.projection()).statusSince).toBe(6);
  await f.append(f.execution, [{ type: 'outputs_preserved', receipt: { preserved: false, artifacts: [], detail: '' } }]);
  expect((await f.projection()).statusSince).toBe(6);
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'parked', reason: 'attempt_failed', detail: 'pause' } }, {
   type: 'outputs_preserved', receipt: { preserved: false, artifacts: [], detail: '' } }]);
  expect((await f.projection()).statusSince).toBe(9);
  const reopened = get(await openJournal(f.location, 'read'));
  expect(get(await readProjection(reopened))).toEqual(await f.projection());
});

it.each(['failed', 'complete', 'cancelled'] as const)('obligations never reopen a %s run or admit workflow parks', async status => {
  await f.admit();
  const ending = { status, reason: status === 'failed' ? 'attempt_failed' as const : status === 'complete' ? 'completed' as const : 'cancelled' as const,
    detail: 'Finished' };
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: ending }]);
  const obligation = { kind: 'closure-unconfirmed' as const, detail: 'Unreaped group', members: [{pid:123,state:'Z',parent:1}] };
  await f.append(f.control, [{ type: 'obligation', obligation, open: true }]);
  expect(await f.projection()).toMatchObject({ status, conclusion: ending, obligations: [obligation] });
  const reopened = get(await openJournal(f.location, 'read'));
  expect(get(await readProjection(reopened))).toEqual(await f.projection());
  for (const reason of ['attempt_failed', 'recovery_unknown'] as const) expect(await appendEvents(f.execution, null,
    [{ type: 'lifecycle', conclusion: { status: 'parked', reason, detail: 'Independent criterion map is unresolved' } }]))
    .toMatchObject({ ok: false, kind: 'conflict' });
  expect(await appendEvents(f.control, null, [{ type: 'control_intent', intent: { id:'Resume',kind:'resume',run:'Run',unit:f.launch.unit,
    expectedCursor:(await f.projection()).cursor } }])).toMatchObject({ok:false,kind:'conflict'});
  await f.append(f.control, [{ type: 'obligation', obligation, open: false }]);
  expect(await f.projection()).toMatchObject({ status, conclusion: ending, obligations: [] });
});

it('only a running lifecycle parks on a blocking obligation, naming it', async () => {
  await f.admit();
  const obligation = {kind:'closure-unconfirmed' as const,detail:'Group unconfirmed',members:[]};
  await f.append(f.control,[{type:'obligation',obligation,open:true}]);
  expect((await f.projection()).status).toBe('pending');
  await f.append(f.control,[{type:'obligation',obligation,open:false}]);
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Attempt',invocation:1}}}]);
  await f.append(f.control,[{type:'obligation',obligation,open:true}]);
  expect(await f.projection()).toMatchObject({status:'parked',conclusion:{detail:'closure-unconfirmed: Group unconfirmed'}});
});

it.each(['closure-unconfirmed','accounting-unsettled','claim-unreleased'] as const)('%s attention appears in status and only blocking obligations park', async kind => {
  await f.admit();
  await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]},
    {type:'active_time_opened',interval:{id:'Open',owner:f.owner,openedAt:new Date().toISOString(),spentMs:null}}]);
  await f.append(f.control,[{type:'obligation',open:true,obligation:{kind,detail:'Interrupted activation',members:[]}}]);
  const reason = kind.replaceAll('-','_');
  const status = kind === 'accounting-unsettled' ? 'running' : 'parked';
  const stopReason = status === 'running' ? null : reason;
  expect((await f.projection()).conclusion?.reason ?? null).toBe(stopReason);
  const {statusView,withState} = await import('../dist-rewrite/records/state.js');
  expect(get(withState(f.database,false,db => statusView(db,f.journal,new Date().toISOString(),null)))).toMatchObject({status,stopReason,attention:{reason}});
});
it('a live interval remains ordinary work after an unrelated workflow park', async () => {
  await f.admit();
  await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Live',owner:f.owner,openedAt:new Date().toISOString(),spentMs:null}},
    {type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Human decision'}}]);
  expect((await f.projection()).obligations).toEqual([]);
});
it('authenticated owner closure derives accounting attention without a caller failure', async () => {
  await f.admit();
  await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Dead',owner:f.owner,openedAt:new Date().toISOString(),spentMs:null}},
    {type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
  await f.append(f.control,[{type:'owner_closed',owner:f.owner}]);
  expect(await f.projection()).toMatchObject({status:'running',obligations:[{kind:'accounting-unsettled'}]});
  expect((await f.projection()).conclusion).toBeUndefined();
});

it.each(['closure-unconfirmed','claim-unreleased'] as const)('atomic reservation refuses pending %s', async kind => {
  await f.admit();
  await f.append(f.control,[{type:'obligation',open:true,obligation:{kind,detail:'Dead activation',members:[]}}]);
  const before = await f.projection();
  expect(await appendEvents(f.execution,null,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'New',invocation:1}}}]))
    .toMatchObject({ok:false,kind:'conflict'});
  expect(await f.projection()).toEqual(before);
});

it.each(['accounting-unsettled', 'closure-unconfirmed', 'claim-unreleased'] as const)(
  'resume applies the blocking rule with an open %s obligation', async kind => {
    await f.admit();
    // Keep genuine dead-activation bookkeeping open so reduction cannot erase the obligation.
    await f.append(f.execution, [
      { type: 'active_time_opened', interval: { id: 'Interrupted', owner: f.owner,
        openedAt: new Date().toISOString(), spentMs: null } },
      { type: 'stage_settled', stage: 'work', state: 'running', evidence: [] },
      { type: 'lifecycle', conclusion: { status: 'parked', reason: 'attempt_failed', detail: 'Workflow needs a human decision' } },
    ]);
    await f.append(f.control, [{ type: 'owner_closed', owner: f.owner }]);
    if (kind !== 'accounting-unsettled') await f.append(f.control,
      [{ type: 'obligation', open: true, obligation: { kind, detail: 'Unresolved effect ownership', members: [] } }]);
    const before = await f.projection();
    expect(before).toMatchObject({ status: 'parked', obligations: expect.arrayContaining([
      expect.objectContaining({ kind: 'accounting-unsettled' }), expect.objectContaining({ kind }),
    ]) });
    const result = await appendEvents(f.control, before.cursor, [{ type: 'control_intent', intent: {
      id: 'Resume', kind: 'resume', run: 'Run', unit: f.launch.unit, expectedCursor: before.cursor,
    } }]);
    if (kind === 'accounting-unsettled') {
      get(result);
      expect(await f.projection()).toMatchObject({ status: 'pending', obligations: before.obligations,
        intervals: before.intervals, intents: [expect.objectContaining({ kind: 'resume' })] });
      await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work',
        address: { kind: 'stage', run: 'Run', stage: 'work', attempt: 'Resumed', invocation: 1 } } }]);
      expect(await f.projection()).toMatchObject({ status: 'running', obligations: before.obligations });
    } else {
      expect(result).toMatchObject({ ok: false, kind: 'conflict' });
      expect(await f.projection()).toEqual(before);
    }
  });

it('projects the stage from a stage-start command before the first author attempt', async () => {
  await f.admit();
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.owner,evidence:[],detail:'Authored live activation'}}]);
  const invocation = {charge:'command' as const,address:{kind:'stage' as const,run:'Run',stage:'work',attempt:'BeforeAuthor',invocation:1}};
  const reservation = {key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},
    identity:'Prepare',invocation,state:'reserved' as const};
  await f.append(f.execution,[{type:'invocation_reserved',invocation},{type:'command_reserved',reservation}]);
  expect(await f.projection()).toMatchObject({status:'running',currentStage:'work',attempts:[],
    stageStates:expect.arrayContaining([expect.objectContaining({stage:'work',state:'running'})])});
  const facts = get(await readEvents(f.journal,0));
  const startedAt = facts.find(event => event.payload.type === 'invocation_reserved')!.at;
  const publishedAt = new Date(Date.parse(startedAt)+10_000).toISOString();
  const snapshot = get(withState(f.database,false,db => statusView(db,f.journal,publishedAt,null)));
  expect(snapshot).toMatchObject({status:'running',currentStage:'work',step:{label:'Command Prepare',startedAt,elapsedMs:10_000}});
  const reopened = get(await openJournal(f.location,'read'));
  expect(get(await readProjection(reopened))).toEqual(await f.projection());
  const nextInvocation={...invocation,address:{...invocation.address,attempt:'SecondCommand'}};
  await f.append(f.execution,[{type:'invocation_reserved',invocation:nextInvocation},{type:'command_reserved',reservation:{
    ...reservation,key:{...reservation.key,context:'d'.repeat(64)},identity:'VerifyNext',invocation:nextInvocation}}]);
  expect(get(withState(f.database,false,db=>statusView(db,f.journal,publishedAt,null))).step.label).toBe('Command VerifyNext');

  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{...invocation.address,attempt:'Author'}}}]);
  expect(await f.projection()).toMatchObject({status:'running',currentStage:'work'});
  expect(get(withState(f.database,false,db => statusView(db,f.journal,publishedAt,null))).step.label).toBe('author · attempt 1');
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'Stopped'}}]);
  expect(await f.projection()).toMatchObject({status:'cancelled',currentStage:null});
});
it('setup and final command reservations do not invent a current stage', async () => {
  await f.admit();
  for (const [index,kind] of (['setup','final'] as const).entries()) {
    const invocation = {charge:'command' as const,address:{kind,run:'Run'}};
    await f.append(f.execution,[{type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{
      key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:String(index).repeat(64)},
      identity:'Prepare',invocation,state:'reserved'}}]);
    expect((await f.projection()).currentStage).toBeNull();
  }
});

it('refuses a command stage absent from the admitted plan without advancing status', async () => {
  await f.admit();
  const invocation = {charge:'command' as const,address:{kind:'stage' as const,run:'Run',stage:'Undefined',attempt:'Attempt',invocation:1}};
  const before = await f.projection();
  expect(await appendEvents(f.execution,before.cursor,[{type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{
    key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},identity:'Check',invocation,state:'reserved'}}]))
    .toMatchObject({ok:false,kind:'invalid'});
  expect(await f.projection()).toEqual(before);
});

it.each(['plan','gate'] as const)('labels a %s attempt from its admitted purpose', async purpose => {
  await f.admit();
  const plan = {...f.plan,stages:f.plan.stages.map(stage=>stage.id==='work'?purpose==='gate'?{id:stage.id,role:stage.role,after:stage.after,purpose,commands:[]}:{...stage,purpose}:stage)};
  await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.owner,evidence:[],detail:'Authored live activation'}}]);
  // Projection consumes an already admitted definition; this test does not exercise graph admission.
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Other',plan,digest:'a'.repeat(64),executed:[]}}]);
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:purpose==='plan'?'plan':'work',
    address:{kind:'stage',run:'Run',stage:'work',attempt:'AttemptNow',invocation:1}}}]);
  const view = get(withState(f.database,false,db=>statusView(db,f.journal,new Date().toISOString(),null)));
  expect(view.step.label).toBe(`${purpose} · attempt 1`);
});

it('refuses an invocation removed from the current admitted plan even when its history remains', async()=>{
  await f.admit();
  await f.append(f.control,[{type:'plan_committed',plan:{revision:'Suffix',plan:{stages:f.plan.stages.filter(s=>s.id!=='work')},
    digest:'a'.repeat(64),executed:[]}}]);
  const before=await f.projection();
  expect(before.stageStates.some(stage=>stage.stage==='work')).toBe(true);
  expect(await appendEvents(f.execution,before.cursor,[{type:'invocation_reserved',invocation:{charge:'work',
    address:{kind:'stage',run:'Run',stage:'work',attempt:'RemovedStage',invocation:1}}}])).toMatchObject({ok:false,kind:'invalid'});
  expect(await f.projection()).toEqual(before);
});

 it('projects generated planning purpose, role, attempt and correction ordinals while retaining exact ids', async () => {
  const bootstrap = await sqlFixture({}, 'bootstrap');
  try {
    await bootstrap.admit();
    await bootstrap.append(bootstrap.control,[{type:'run_observed',observation:{unit:bootstrap.launch.unit,state:'active',owner:bootstrap.owner,evidence:[],detail:'Native controller'}}]);
    const snapshot = () => get(withState(bootstrap.database,false,db=>statusView(db,bootstrap.journal,new Date().toISOString(),null)));
    const reserve = async (attempt:string, invocation:number, charge:'plan'|'correction') => bootstrap.append(bootstrap.execution,[
      {type:'invocation_reserved',invocation:{charge,address:{kind:'stage',run:'Run',stage:'planner',attempt,invocation}}}]);
    await reserve('r_first_uuid',1,'plan');
    expect(snapshot()).toMatchObject({currentStage:'planner',step:{stageLabel:'plan (author)',label:'plan · attempt 1',attempt:'r_first_uuid'}});
    await reserve('r_first_uuid',2,'correction');
    await reserve('r_first_uuid',3,'correction');
    expect(snapshot().step).toMatchObject({stageLabel:'plan (author)',label:'plan · attempt 1 · correction 3',attempt:'r_first_uuid'});
    await reserve('r_second_uuid',1,'plan');
    expect(snapshot().step).toMatchObject({label:'plan · attempt 2',attempt:'r_second_uuid'});
    await bootstrap.append(bootstrap.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'done'}}]);
    expect(snapshot()).toMatchObject({currentStage:null,step:{stageLabel:null,label:null,attempt:null}});
  } finally {await bootstrap.close();}
});

it.each(['cgroup','marker'] as const)('status retains the %s receipt guarantee and unknown-environment detail without replay', async guarantee => {
  await f.admit();
  const containment = guarantee === 'cgroup' ? {kind:guarantee,inode:'123',path:'/scope'}
    : {kind:guarantee,marker:'11111111-1111-4111-8111-111111111111'};
  const owner = {...f.owner,containment};
  const detail = guarantee === 'marker' ? 'marker: best effort; unreadable PID 77 not signalled; owner retired' : 'cgroup: proven recursive descendant closure.';
  const ref = {path:'evidence',sha256:'a'.repeat(64)};
  await f.append(f.execution,[{type:'ownership',owner,state:'live'},
    {type:'process',receipt:{owner,state:'closed',exit:0,signal:null,stdout:ref,stderr:ref,durationMs:1,scope:'group',guarantee,detail,unknownPids:guarantee === 'marker' ? [77] : []}}]);
  expect(get(await readEvents(f.journal,0)).at(-1)?.payload).toMatchObject({type:'process',receipt:{owner:{containment},guarantee,detail}});
  const view = () => get(withState(f.database,false,db=>statusView(db,f.journal,new Date().toISOString(),null)));
  expect(view().host.interpretation).toContain(detail);
  expect(view().host.interpretation).toContain(detail);
});

it('command reservations require adjacent matching invocation facts and create no advisory rows',async()=>{
  await f.admit();
  const invocation={charge:'command' as const,address:{kind:'stage' as const,run:'Run',stage:'gate',attempt:'Attempt',invocation:1}};
  const reservation={identity:'Check',key:{tree:'a'.repeat(64),context:'b'.repeat(64),declaration:'c'.repeat(64),inputHashes:[]},
    invocation,state:'reserved' as const};
  const before=(await f.projection()).cursor;
  for(const payload of [{type:'invocation_reserved' as const,invocation},{type:'command_reserved' as const,reservation}])
    expect(await appendEvents(f.execution,before,[payload])).toMatchObject({ok:false,kind:'conflict'});
  expect(await appendEvents(f.execution,before,[{type:'invocation_reserved',invocation},
    {type:'outputs_preserved',receipt:{preserved:false,artifacts:[],detail:'Unrelated fact in the same transaction'}},
    {type:'command_reserved',reservation}])).toMatchObject({ok:false,kind:'conflict'});
  await f.append(f.execution,[{type:'invocation_reserved',invocation},{type:'command_reserved',reservation}]);
  expect((await f.projection()).reservations).toMatchObject([{identity:'Check',invocation}]);
  expect((await f.projection()).activity).toBeUndefined();
  const {readAdvisoryActivity}=await import('../dist-rewrite/records/state.js');
  expect(get(readAdvisoryActivity(f.journal))).toEqual([]);
});
