import {DatabaseSync} from 'node:sqlite';
import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile,access,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isFinal,claim,release,openWriter,appendEvents,reconcileClaims,workAdmission,readClosure} from '../../dist-rewrite/records/state.js';
import {reconcileRun,attendRun} from '../../dist-rewrite/ops/reconcile.js';
import {operateRun} from '../../dist-rewrite/ops/run.js';
import {land} from '../../dist-rewrite/ops/land.js';
import * as host from '../../dist-rewrite/host/process.js';
import {stateFixture,get} from '../fixtures/rewrite-state.js';
import {runServices} from '../fixtures/rewrite-run-services.js';
vi.mock('../../dist-rewrite/host/process.js',async original=>({...await original<typeof import('../../dist-rewrite/host/process.js')>(),observeRun:vi.fn()}));
// The lifecycle owner supplies eligibility; closure is exercised at the native boundary below.
it.each([['pending',false],['running',false],['parked',false],['cancelled',true],['failed',true],['incomplete',true],
  ['complete',true],['accepted_blocked',true],['escalated',true]] as const)('resource eligibility %s => %s', (status,terminal)=>{
  expect(isFinal(status)).toBe(terminal);
});
it('unknown closure and failed capture hold the extent; closed capture releases it without reclaim and retains A after B writes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'resource-transition-')),external=join(root,'external'),retained=join(root,'retained-external');await mkdir(external);
  const f=await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'},{path:external,kind:'directory',existing:'replace'}]});
  const next={database:f.database,holder:join(f.location.storeRoot,'runs','Next')};
  try {
    await f.admit();await writeFile(join(external,'result'),'A bytes');await writeFile(join(f.project,'delivery'),'project bytes');
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'Stopped author'}}]);
    await f.releaseClaims(); // no closure observation: admission is still held
    expect(await claim(external,null,next)).toMatchObject({ok:false,kind:'conflict',detail:expect.stringMatching(/run Run.*closure/)});
    await rename(external,retained);await mkdir(join(root,'aliased'));await symlink('aliased',external);
    const held=get(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer=get(await openWriter(f.journal,held,'control'));
    const observation={unit:f.launch.unit,state:'inactive' as const,owner:null,evidence:[],detail:'Confirmed closed'};
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    get(await reconcileRun(writer,runServices(f).process(writer),f.unitContext,[held],false));
    expect((await f.projection()).obligations).toMatchObject([{kind:'claim-unreleased',detail:'Aliased content path'}]);
    get(await release(held));
    const db=new DatabaseSync(f.database);
    try{expect(db.prepare('SELECT owner FROM resources WHERE holder=? AND path=?').get(f.journal.root,held.resource)).toMatchObject({owner:null});}finally{db.close();}
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    const partial=get(await land(f.location,runServices(f).process,f.unitContext));
    expect(partial).toMatchObject({state:'partial',outputs:{disposition:'unreviewed'}});
    expect(partial.outputs.artifacts).toHaveLength(1);
    const {materializeDelivery}=await import('../../dist-rewrite/records/content.js');
    get(await materializeDelivery(f.journal,partial.outputs.artifacts,join(root,'partial')));
    expect(await readFile(join(root,'partial','project','delivery'),'utf8')).toBe('project bytes');
    expect(await readFile(join(f.project,'delivery'),'utf8')).toBe('project bytes');
    expect(await claim(retained,null,next)).toMatchObject({ok:false,kind:'conflict'});
    const retry=get(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    await rm(external);await rename(retained,external);await writeFile(join(external,'result'),'A bytes');
    expect(await claim(external,null,next)).toMatchObject({ok:false,kind:'conflict'});
    const retryWriter=get(await openWriter(f.journal,retry,'control'));
    const runOperation=host.runOperation;
    const raced=vi.spyOn(host,'runOperation').mockImplementation(async(request,...args)=>{
      const result=await runOperation(request,...args);
      if(request.method==='captureExecutionOutputs'){
        const db=new DatabaseSync(f.database);
        try{db.prepare("UPDATE resources SET epoch='ChangedEpoch' WHERE holder=? AND path=? AND id LIKE 'plan:%'").run(f.journal.root,external);}finally{db.close();}
      }
      return result;
    });
    get(await reconcileRun(retryWriter,runServices(f).process(retryWriter),f.unitContext,[retry],false));
    expect((await f.projection()).obligations).toMatchObject([{kind:'claim-unreleased',detail:'Execution resource epoch changed'}]);
    raced.mockRestore();
    expect((await f.projection()).outputs).toHaveLength(1); // only partial land, no raced release receipt
    expect(await claim(external,null,next)).toMatchObject({ok:false,kind:'conflict'});
    // Advancing the journal during capture invalidates this reconciliation's result.
    const {appendEvents}=await import('../../dist-rewrite/records/state.js');
    const moved=vi.spyOn(host,'runOperation').mockImplementation(async(request,...args)=>{
      const result=await runOperation(request,...args);
      if(request.method==='captureExecutionOutputs')get(await appendEvents(retryWriter,null,[{type:'run_observed',observation}]));
      return result;
    });
    get(await reconcileRun(retryWriter,runServices(f).process(retryWriter),f.unitContext,[retry],false));
    moved.mockRestore();
    expect((await f.projection()).obligations).toMatchObject([{kind:'claim-unreleased',detail:'Run changed during execution resource retirement'}]);
    expect((await f.projection()).outputs).toHaveLength(1);
    expect(await claim(external,null,next)).toMatchObject({ok:false,kind:'conflict'});
    get(await reconcileRun(retryWriter,runServices(f).process(retryWriter),f.unitContext,[retry],false));
    get(await release(retry));
    const b=get(await claim(external,null,next));
    await writeFile(join(external,'result'),'B bytes');get(await release(b));
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    const delivery=get(await land(f.location,runServices(f).process,f.unitContext));
    expect(delivery.outputs.detail).toBe('Unreviewed retained observation');
    expect(await readFile(join(delivery.delivery!,'external','1','result'),'utf8')).toBe('A bytes');
    expect(await readFile(join(external,'result'),'utf8')).toBe('B bytes');
    expect((await f.projection()).status).toBe('cancelled');
    const reclaimedDb=new DatabaseSync(f.database);
    try{expect(reclaimedDb.prepare('SELECT * FROM resources WHERE holder=?').all(f.journal.root)).toEqual([]);}finally{reclaimedDb.close();}
    for(const path of [f.project,external]){const later=get(await claim(path,null,next));get(await release(later));}
  }finally{vi.restoreAllMocks();await f.close();await rm(root,{recursive:true,force:true});}
});

it.each(['complete','failed'] as const)('%s releases external execution bytes after reconciliation; unknown closure holds',async status=>{
  const root=await mkdtemp(join(tmpdir(),'resource-terminal-')),external=join(root,'external');await mkdir(external);
  const f=await stateFixture({outputs:[{path:external,kind:'directory',existing:'replace'}]});
  const next={database:f.database,holder:join(f.location.storeRoot,'runs','Next')};
  try {
    await f.admit();await writeFile(join(external,'result'),'terminal bytes');
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status,reason:status==='complete'?'completed':'attempt_failed',detail:'Terminal fixture'}},
      {type:'ownership',owner:f.owner,state:'dead'},
      {type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.owner,evidence:[],detail:'Stale active activation'}}]);
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'unknown',owner:null,evidence:[],detail:'Unknown'}});
    expect(await land(f.location,runServices(f).process,f.unitContext)).toMatchObject({ok:false,kind:'unknown'});
    expect(await claim(external,null,next)).toMatchObject({ok:false,kind:'conflict'});
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Closed'}});
    const {operateRun}=await import('../../dist-rewrite/ops/run.js');
    const closed=get(await operateRun({location:f.location,intent:{id:'Close',kind:'cancel',run:'Run',unit:f.launch.unit,
      expectedCursor:(await f.projection()).cursor}},runServices(f)));
    expect(closed.state).toBe('acknowledged');
    const b=get(await claim(external,null,next));get(await release(b));
    expect((await f.projection()).status).toBe(status);
    const settled=new DatabaseSync(f.database);
    try{expect(settled.prepare("SELECT * FROM epochs WHERE root=? AND kind='execution' AND active=1").all(f.journal.root)).toEqual([]);}finally{settled.close();}
  }finally{vi.restoreAllMocks();await f.close();await rm(root,{recursive:true,force:true});}
});

it.each(['dead', 'reused'] as const)('%s ignores a recorded group reused by an unrelated live process in land and cancel', async state => {
  const f = await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'}]});
  const old = get(await host.beginOperation()), unrelated = get(await host.beginOperation());
  try {
    get(await host.endOperation(old.owner));
    // Model the OS reusing the recorded PGID: old authority, new live process group.
    const recorded = {...old.owner, group:unrelated.owner.group};
    await f.admit(); await writeFile(join(f.project,'delivery'),'retained bytes');
    await f.append(f.execution,[{type:'owner_closed',owner:recorded},
      {type:'ownership',owner:recorded,state},{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Ended run'}}]);
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    const signals = vi.spyOn(process,'kill');
    try {
      expect(get(await land(f.location,runServices(f).process,f.unitContext)).state).toBe('reclaimed');
      expect(get(await operateRun({location:f.location,intent:{id:'Cancel',kind:'cancel',run:'Run',unit:f.launch.unit,
        expectedCursor:(await f.projection()).cursor}},runServices(f))).state).toBe('acknowledged');
      expect(signals.mock.calls.filter(([pid]) => pid === -unrelated.owner.group)).toEqual([]);
    } finally {signals.mockRestore();}
    expect(host.groupState(unrelated.owner)).toBe('live');
  } finally {vi.restoreAllMocks(); await host.endOperation(old.owner); await host.endOperation(unrelated.owner); await f.close();}
});

it('a live prior claim refusal leaves a running run admitted without obligations',async()=>{
  const f=await stateFixture();
  let held: host.Claim | undefined;
  try {
    await f.admit();
    await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Start',invocation:1}}}]);
    held=get(await claim(join(f.root,'prior'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    expect(await reconcileRun(f.control,runServices(f).process(f.control),f.unitContext,
      [f.scope.projectClaim,{epoch:f.execution.epoch},{epoch:f.control.epoch}] as host.Claim[],false))
      .toMatchObject({ok:false,kind:'conflict',detail:'Prior claim owner still live'});
    expect((await f.projection()).obligations).toEqual([]);
    get(await attendRun(f.control,{ok:false,kind:'conflict',detail:'ordinary refusal'},true));
    const projection=await f.projection();
    expect(projection.status).toBe('running'); expect(projection.obligations).toEqual([]);
    expect(workAdmission(projection)).toEqual({ok:true,value:null});
  } finally {if(held)get(await release(held));await f.close();}
});

it('reclaim leaves a claimant acquired after land releases execution in place',async()=>{
  const f=await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'}]});
  let later: host.Claim | undefined;
  try {
    await f.admit();await writeFile(join(f.project,'delivery'),'retained bytes');
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'cancelled'}}]);
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    const end=host.endOperation;
    const raced=vi.spyOn(host,'endOperation').mockImplementation(async owner=>{
      const result=await end(owner);
      const db=new DatabaseSync(f.database);
      let row;
      try {row=db.prepare('SELECT path FROM resources WHERE holder=? AND owner=? AND path=?')
        .get(f.journal.root,JSON.stringify(owner),join(f.journal.root,'control'));} finally {db.close();}
      // Cleanup reverses land claims: execution has been released when control closes.
      if(row && !later) later=get(await claim(join(f.journal.root,'execution'),f.launch.unit,{database:f.database,holder:f.journal.root}));
      return result;
    });
    expect(get(await land(f.location,runServices(f).process,f.unitContext)).state).toBe('reclaimed');
    raced.mockRestore();
    expect(later).toBeDefined();
    const db=new DatabaseSync(f.database);
    try {
      expect(db.prepare('SELECT epoch,owner FROM resources WHERE holder=?').all(f.journal.root))
        .toEqual([{epoch:later!.epoch,owner:JSON.stringify(later!.owner)}]);
      expect(db.prepare('SELECT * FROM epochs WHERE root=? AND active=1').all(f.journal.root)).toEqual([]);
    } finally {db.close();}
  } finally {vi.restoreAllMocks();if(later)await release(later);await f.close();}
});

it('claim replacement deactivates the dead writer epoch before reconciliation',async()=>{
  const f=await stateFixture();let replacement:host.Claim|undefined;
  try {
    await f.admit();await f.releaseClaims();
    const old=get(await claim(join(f.journal.root,'execution'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer=get(await openWriter(f.journal,old,'execution'));
    get(await host.endOperation(old.owner));
    replacement=get(await claim(old.resource,f.launch.unit,{database:f.database,holder:f.journal.root}));
    const db=new DatabaseSync(f.database);
    try {expect(db.prepare('SELECT active FROM epochs WHERE root=? AND epoch=?').get(f.journal.root,old.epoch)).toMatchObject({active:0});}
    finally {db.close();}
    expect(await appendEvents(writer,null,[{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'stale'}}]))
      .toMatchObject({ok:false,kind:'conflict'});
    get(await reconcileClaims(f.journal,[replacement]));
  } finally {
    if(replacement)get(await release(replacement));await f.close();
  }
});

it('partial reclaim skips missing outside parents without recreating any deletion target',async()=>{
  const f=await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'}]});
  const {reclaimTask}=await import('../../dist-rewrite/ops/land.js');
  try {
    await f.admit();await writeFile(join(f.project,'delivery'),'retained bytes');
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'cancelled'}}]);
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    const operation=host.runOperation;
    const interrupted=vi.spyOn(host,'runOperation').mockImplementation(async(request,...args)=>request.method==='reclaimTask'
      ? {ok:false,kind:'unavailable',detail:'partial reclaim'} : operation(request,...args));
    expect(await land(f.location,runServices(f).process,f.unitContext)).toMatchObject({ok:false,kind:'unavailable'});
    interrupted.mockRestore();
    const outside=join(f.root,'absent-outside'),inside=join(f.location.storeRoot,'absent-inside');
    await rm(f.project,{recursive:true});await rm(join(f.location.storeRoot,'runtime'),{recursive:true});
    await mkdir(join(f.location.storeRoot,'work'),{recursive:true});
    get(await reclaimTask(f.journal,join(outside,'project'),join(inside,'runtime'),join(f.location.storeRoot,'work','Run')));
    for(const path of [outside,inside,f.project,join(f.location.storeRoot,'runtime')]) await expect(access(path)).rejects.toMatchObject({code:'ENOENT'});
    expect(get(await land(f.location,runServices(f).process,f.unitContext)).state).toBe('reclaimed');
  }finally{vi.restoreAllMocks();await f.close();}
});


it('a closed interval with an unconfirmed closure still probes and settles only after endOperation succeeds',async()=>{
  const f=await stateFixture(), worker=get(await host.beginOperation());
  let held:host.Claim|undefined;
  try {
    await f.admit();get(await host.endOperation(worker.owner));
    const obligation={kind:'closure-unconfirmed' as const,owner:worker.owner,members:[],detail:'Closure still unconfirmed'};
    await f.append(f.execution,[{type:'ownership',owner:worker.owner,state:'unknown'},
      {type:'active_time_opened',interval:{id:'Old',owner:worker.owner,openedAt:new Date().toISOString(),spentMs:null}},
      {type:'active_time_closed',interval:'Old',spentMs:1},{type:'obligation',obligation,open:true}]);
    // Output quiescence also needs native proof despite the closed interval.
    const probe=vi.spyOn(host,'probeOwner');
    probe.mockResolvedValueOnce('live');
    expect(await readClosure(f.journal)).toMatchObject({ok:false,kind:'conflict'});
    expect(probe).toHaveBeenCalledWith(worker.owner);
    probe.mockRestore();await f.releaseClaims();
    held=get(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer=get(await openWriter(f.journal,held,'control'));
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    const probes=vi.spyOn(host,'probeOwner'),end=host.endOperation;
    const closes=vi.spyOn(host,'endOperation').mockImplementation(async owner=>{
      if(owner.authority===worker.owner.authority) return {ok:false,kind:'unknown',detail:obligation.detail,
        closure:{state:'not_confirmed_closed',owner,observation:'unknown',members:[]}};
      return end(owner);
    });
    expect(await reconcileRun(writer,runServices(f).process(writer),f.unitContext,[held],false)).toMatchObject({ok:false,kind:'unknown'});
    expect(probes).toHaveBeenCalledWith(worker.owner);expect(closes).toHaveBeenCalledWith(worker.owner);
    expect((await f.projection()).obligations).toContainEqual(obligation);
    expect((await f.projection()).owners).toContainEqual({owner:worker.owner,state:'unknown'});
    closes.mockImplementation(async owner=>{
      if(owner.authority===worker.owner.authority) expect((await f.projection()).obligations).toContainEqual(obligation);
      return end(owner);
    });
    get(await reconcileRun(writer,runServices(f).process(writer),f.unitContext,[held],false));
    expect((await f.projection()).obligations).toEqual([]);
    expect((await f.projection()).owners).toContainEqual({owner:worker.owner,state:'dead'});
  }finally{vi.restoreAllMocks();if(held)get(await release(held));await host.endOperation(worker.owner);await f.close();}
});

it('reclaim retires only ownerless reservations matching the recorded run epochs',async()=>{
  const f=await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'}]});
  try {
    await f.admit();await writeFile(join(f.project,'delivery'),'retained bytes');
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'cancelled'}}]);
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'closed'}});
    // An unmatched epoch must survive even if its holder and owner-null shape match.
    const db=new DatabaseSync(f.database);let id:string;
    try {
      id=String(db.prepare("SELECT id FROM resources WHERE holder=? AND id LIKE 'plan:%' LIMIT 1").get(f.journal.root)!.id);
      db.prepare("UPDATE resources SET epoch='UnrecordedEpoch' WHERE id=?").run(id);
      db.prepare("INSERT INTO resources(id,holder,path,access,epoch) VALUES(?,?,?,'exclusive-write','UnrecordedOperation')")
        .run('operation:Unmatched', f.journal.root, join(f.journal.root, 'operation-sentinel'));
    }finally{db.close();}
    expect(get(await land(f.location,runServices(f).process,f.unitContext)).state).toBe('reclaimed');
    const after=new DatabaseSync(f.database);
    try {expect(after.prepare('SELECT id,epoch FROM resources WHERE holder=?').all(f.journal.root)).toEqual([{id,epoch:'UnrecordedEpoch'}, {id:'operation:Unmatched',epoch:'UnrecordedOperation'}]);}
    finally{after.close();}
  }finally{vi.restoreAllMocks();await f.close();}
});
