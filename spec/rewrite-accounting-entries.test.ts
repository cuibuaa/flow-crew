import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { putAuthored } from './fixtures/rewrite-bytes.js';
import { sqlFixture, get } from './fixtures/rewrite-sql.js';
import * as host from '../dist-rewrite/host/process.js';
import { reconcileRun } from '../dist-rewrite/ops/reconcile.js';
import * as records from '../dist-rewrite/records/state.js';
import { operateRun, runUnitEntry } from '../dist-rewrite/ops/run.js';
import { land } from '../dist-rewrite/ops/land.js';
import { publishRunStatus } from '../dist-rewrite/ops/status.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';
import type { RunServices } from '../dist-rewrite/ops/run.js';

vi.mock('../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/content.js')>(),
  verifyRuntime: vi.fn(async (_root, ref) => ({ok:true,value:ref})),
  validateRecordLayout: vi.fn(async layout => ({ok:true,value:layout})),
  hashInputs: vi.fn(async () => ({ok:true,value:[]})),
  readCheckpoint: vi.fn(async () => ({ok:true,value:{tree:'a'.repeat(64),manifest:{path:'authored/checkpoint',sha256:'a'.repeat(64)}}})),
  captureTree: vi.fn(async () => ({ok:true,value:'a'.repeat(64)})),
  preserveOutputs: vi.fn(async () => ({ok:true,value:{preserved:true,artifacts:[],detail:'authored delivery'}})),
}));
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  recordOperation: vi.fn(async () => ({ok:true,value:true})),
}));
vi.mock('../dist-rewrite/core/loop.js', () => ({runWorkflow:vi.fn()}));

const entries = ['resume','unit','preserve','reclaim','guide','status'] as const;
afterEach(() => vi.clearAllMocks());
it.each(entries.flatMap(entry => (['dead','live'] as const).map(activation => ({entry,activation}))))(
  '$entry with $activation activation accounting', async ({entry,activation}) => {
  for (const key of ['observeRun','startRun','stopRun','probeOwner','endOperation'] as const) vi.spyOn(host,key);
  const f = await sqlFixture();
  try {
    await f.admit();
    const interval = {id:'Prior',owner:f.owner,openedAt:'2026-01-01T00:00:00.000Z',spentMs:null};
    const invocation = {charge:'command' as const,address:{kind:'stage' as const,run:'Run',stage:'work',attempt:'Prior',invocation:1}};
    const reservation = {key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},identity:'Check',invocation,state:'reserved' as const};
    await f.append(f.execution,[{type:'active_time_opened',interval},
      {type:'stage_settled',stage:'work',state:'running',evidence:[]},
      ...(activation === 'dead' ? [{type:'invocation_reserved' as const,invocation},{type:'command_reserved' as const,reservation}] : [])]);
    if (entry === 'preserve' || entry === 'reclaim') await f.append(f.execution,[{type:'checkpoint',checkpoint:{
      id:'Delivery',address:{run:'Run',stage:'work',attempt:'Prior',invocation:1},parent:null,state:'safe',
      manifest:putAuthored(Buffer.from('checkpoint')),tree:'a'.repeat(64),brief:f.brief.digest,inputHashes:[],evidence:[]}}]);
    if (entry === 'reclaim') await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained final run'}}]);
    if (activation === 'dead') await f.append(f.control,[{type:'owner_closed',owner:f.owner}]);
    else expect(await records.appendEvents(f.control,null,[{type:'accounting_interrupted'}])).toMatchObject({ok:false,kind:'unknown'});
    await f.releaseClaims();
    vi.mocked(host.endOperation).mockClear();
    const observation = {unit:f.launch.unit,state:activation === 'dead' ? 'inactive' as const : 'active' as const,
      owner:activation === 'dead' ? null : f.owner,evidence:[],detail:'authored activation observation'};
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    vi.mocked(host.startRun).mockResolvedValue({ok:true,value:{...observation,state:'active'}});
    vi.mocked(host.stopRun).mockResolvedValue({ok:true,value:{...observation,state:'inactive'}});
    vi.mocked(host.probeOwner).mockImplementation(async owner => owner.authority === f.owner.authority && activation === 'dead' ? 'dead' : 'live');
    const services = {configuration:{...f.configuration,sharedCaches:[],devices:[],providerHomes:{codex:[],claude:[]}},
      unitContext:f.unitContext,configRoot:join(f.location.storeRoot,'runtime','config'),privateEnvironment:{},
      process:() => ({}),workflowPorts:vi.fn(() => ({}))} as unknown as RunServices;
    vi.mocked(runWorkflow).mockImplementation(async () => {
      const p = await f.projection();
      expect(p.intervals.find(i => i.id === 'Prior')).toMatchObject({closed:'unmeasured',spentMs:null});
      expect(p.reservations[0]).toMatchObject({state:'closed-unmeasured'});
      expect(p.obligations).toEqual([]);
      return {ok:true,value:{status:'complete',reason:'completed',detail:'Reached workflow'}};
    });
    const before = await f.projection();
    if (entry === 'status') {
      const status = get(publishRunStatus(f.location,new Date().toISOString(),null));
      expect(status.status).toBe('running');
      expect(status.stopReason).toBeNull();
      if (activation === 'dead') expect(status.attention?.obligations).toContainEqual(
        expect.objectContaining({kind:'accounting-unsettled'}));
      expect(status.attention?.obligations?.some(o => o.kind !== 'accounting-unsettled') ?? false).toBe(false);
      expect(await f.projection()).toEqual(before);
    } else if (entry === 'unit') {
      const result = await runUnitEntry(f.location,f.launch.unit,services,new AbortController().signal);
      if (activation === 'dead') expect(result).toMatchObject({ok:true,value:{status:'complete'}});
      else expect(result).toMatchObject({ok:false,kind:'conflict'});
    } else if (entry === 'preserve' || entry === 'reclaim') {
      const result = await land(f.location,entry,services.process,f.unitContext);
      expect(result).toMatchObject(activation === 'dead'
        ? {ok:true,value:{state:entry === 'preserve' ? 'preserved' : 'reclaimed'}}
        : {ok:false,kind:'conflict',detail:'Run unit is active'});
    } else {
      const result = await operateRun({location:f.location,intent:{id:'Entry',kind:entry,run:'Run',unit:f.launch.unit,expectedCursor:before.cursor,
        ...(entry === 'guide' ? {intervention:{kind:'guide' as const,address:{run:'Run',stage:'work',attempt:'Prior',invocation:1},content:putAuthored(Buffer.from('guidance')),
          replacement:{baseRevision:'Revision',plan:f.plan}}} : {})}} as Parameters<typeof operateRun>[0],services);
      expect(result).toMatchObject({ok:true,value:{state:'acknowledged'}});
      if (entry === 'resume') expect(host.startRun).toHaveBeenCalledTimes(activation === 'dead' ? 1 : 0);
    }
    const after = await f.projection();
    if (entry !== 'status' && activation === 'dead') {
      expect(after.intervals.find(i => i.id === 'Prior')).toMatchObject({spentMs:null,closed:'unmeasured'});
      expect(after.reservations[0]).toMatchObject({state:'closed-unmeasured'});
      expect(after.obligations).toEqual([]);
    }
    if (activation === 'live') {
      expect(after.intervals).toEqual(before.intervals);
      expect(after.obligations).toEqual([]);
      expect(after.status).toBe(before.status);
      expect(host.endOperation).not.toHaveBeenCalledWith(f.owner);
    }
  } finally { await f.close(); }
});

// Keep the real SQL claims and writer epochs throughout the decision.
it.each([false, true].flatMap(stop => (['live', 'unknown'] as const).map(ownerState => ({stop, ownerState}))))(
  'reconcile stop=$stop with $ownerState predecessor retains claims until closure', async ({stop, ownerState}) => {
  const f = await sqlFixture();
  for (const key of ['observeRun','stopRun','probeOwner','endOperation'] as const) vi.spyOn(host,key);
  try {
    await f.admit();
    await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Prior',owner:f.owner,
      openedAt:'2026-01-01T00:00:00.000Z',spentMs:null}}]);
    const observation = {unit:f.launch.unit,state:'inactive' as const,owner:null,evidence:[],detail:'Unit stopped'};
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    vi.mocked(host.stopRun).mockResolvedValue({ok:true,value:observation});
    vi.mocked(host.probeOwner).mockResolvedValue(ownerState);
    const unclosed = {ok:false as const,kind:'unknown' as const,detail:'Bounded group closure unconfirmed',
      closure:{state:'not_confirmed_closed' as const,owner:f.owner,observation:ownerState,
        members:[{pid:f.owner.pid,state:'S',parent:null}]}};
    vi.mocked(host.endOperation).mockResolvedValue(unclosed);
    const claims = () => { const db = new DatabaseSync(f.database); try {
      return db.prepare('SELECT * FROM resources WHERE owner IS NOT NULL ORDER BY id').all();
    } finally { db.close(); } };
    const before = await f.projection(), held = claims();
    expect(held).toHaveLength(3);
    const result = await reconcileRun(f.control,{} as host.ProcessPorts,f.unitContext,[],stop);
    if (!stop && ownerState === 'live') {
      expect(result).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
      expect(host.endOperation).not.toHaveBeenCalled();
      expect((await f.projection()).obligations).toEqual([]);
    } else {
      expect(result).toEqual(unclosed);
      expect(host.endOperation).toHaveBeenCalledWith(f.owner);
      const p = await f.projection();
      expect(p.obligations).toContainEqual(expect.objectContaining({kind:'closure-unconfirmed',owner:f.owner,
        members:unclosed.closure.members}));
      expect(get(publishRunStatus(f.location,new Date().toISOString(),null)).attention?.obligations)
        .toContainEqual(expect.objectContaining({kind:'closure-unconfirmed'}));
    }
    expect(host.stopRun).toHaveBeenCalledTimes(stop ? 1 : 0);
    expect(claims()).toEqual(held);
    expect((await f.projection()).intervals).toEqual(before.intervals);
    expect((await f.projection()).status).toBe(before.status);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('unknown unit entry is a refusal without a lifecycle or attention fact', async () => {
  const f = await sqlFixture();
  try {
    await f.admit();
    await f.releaseClaims();
    vi.spyOn(host,'observeRun').mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'unknown',owner:null,
      evidence:[],detail:'Unavailable unit observation'}});
    const before = await f.projection();
    const services = {configuration:f.configuration,unitContext:f.unitContext,configRoot:join(f.location.storeRoot,'runtime','config'),process:() => ({})} as unknown as RunServices;
    expect(await runUnitEntry(f.location,f.launch.unit,services,new AbortController().signal))
      .toMatchObject({ok:false,kind:'unknown',detail:'Run unit state unknown'});
    const after = await f.projection();
    expect(after.status).toBe(before.status);
    expect(after.conclusion).toEqual(before.conclusion);
    expect(after.obligations).toEqual(before.obligations);
  } finally { vi.restoreAllMocks(); await f.close(); }
});
