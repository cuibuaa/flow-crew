import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendEvents, readEvents, listProjections, openJournal, readProjection } from '../dist-rewrite/records/state.js';
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
