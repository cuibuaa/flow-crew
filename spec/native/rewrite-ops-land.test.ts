import { DatabaseSync } from 'node:sqlite';
import { publishRunStatus } from '../../dist-rewrite/ops/status.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { access, writeFile, readFile, readdir, rm, symlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as host from "../../dist-rewrite/host/process.js";
import { land } from "../../dist-rewrite/ops/land.js";
import { heldBytes, rawEvidence, reclaimTargets } from "../../dist-rewrite/records/held.js";
import { lstatSync, readdirSync } from 'node:fs';
import { captureCheckpoint, settleFrozenInputs } from "../../dist-rewrite/records/content.js";
import { readEvidence } from "../../dist-rewrite/records/evidence.js";
import { runServices } from "../fixtures/rewrite-run-services.js";
import { stateFixture, get, digest, type StateFixture } from "../fixtures/rewrite-state.js";
vi.mock("../../dist-rewrite/host/process.js", async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 observeRun: vi.fn() }));
let f: StateFixture;
beforeEach(async () => { f = await stateFixture({ outputs: [{ path: 'delivery', kind: 'file', existing: 'replace' }] }); await f.admit();
 vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null, evidence: [],
 detail: 'fixture manager' } }); });
afterEach(async () => { vi.clearAllMocks(); await f.close(); });
async function checkpoint() { await writeFile(join(f.project, 'delivery'), 'preserved bytes');
 const cp = get(await captureCheckpoint(f.scope, { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, null, 'safe', [], get(await settleFrozenInputs(f.scope)).inputs));
 await f.append(f.execution, [{ type: 'checkpoint', checkpoint: cp }]); return cp; }
it('uses real content and SQL to land a closed delivery: preserve, materialize, then reclaim', async () => {
  const cp = await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'incomplete', reason: 'outputs_unpreserved',
   detail: 'retained work' } }]);
  await f.releaseClaims();
  const report = get(await land(f.location, runServices(f).process, f.unitContext));
  expect(report.state).toBe('reclaimed');
  expect(report.outputs.artifacts).toHaveLength(1);
  expect((await readEvidence(f.journal, cp.manifest)).ok).toBe(false);
  expect(await readFile(join(f.location.storeRoot, 'deliveries', f.location.run, 'delivery'), 'utf8')).toBe('preserved bytes');
  await expect(access(join(f.journal.root, 'git-common'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(f.location.storeRoot, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(get(publishRunStatus(f.location, new Date().toISOString(), null)).reclaimed).toMatchObject({ at: expect.any(String) });
  const db = new DatabaseSync(f.database);
  try { expect(db.prepare('SELECT * FROM resources WHERE holder=?').all(f.journal.root)).toEqual([]); } finally { db.close(); }
  expect(get(await land(f.location, runServices(f).process, f.unitContext)).state).toBe('reclaimed');
  expect((await f.projection()).status).toBe('incomplete');
  await expect(access(f.project)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('an active manager refusal leaves the real SQL delivery untouched', async () => {
  const state = 'active';
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  await f.releaseClaims();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state, owner: null, evidence: [], detail: '' } });
  expect(await land(f.location, runServices(f).process, f.unitContext)).toMatchObject({ ok: false,
   kind: 'conflict', detail: 'Run unit is active' });
  expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
});
it('settles interrupted reservations as closed-unmeasured after confirmed closure', async () => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'command', address: { kind: 'final', run: 'Run' } } },
   { type: 'command_reserved', reservation: { identity: 'Check', state: 'reserved', key: { tree: 'a'.repeat(64), declaration: 'a'.repeat(64),
   context: 'a'.repeat(64), inputHashes: [] }, invocation: { charge: 'command', address: { kind: 'final', run: 'Run' } } } }, {
   type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  await f.releaseClaims();
  expect(await land(f.location, runServices(f).process, f.unitContext)).toMatchObject({ ok: true, value: {state:'reclaimed'} });
  expect((await f.projection()).reservations[0]).toMatchObject({state:'closed-unmeasured'});
  expect((await f.projection()).commands).toEqual([]);
  expect(await readFile(join(f.location.storeRoot, 'deliveries', 'Run', 'delivery'), 'utf8')).toBe('preserved bytes');
});
import { recordOperation, readEvents } from "../../dist-rewrite/records/state.js";
it('preservation failure before archive never deletes the project', async () => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'retained' } }]);
  await f.releaseClaims();
  // A real capture failure (aliased output), independent of checkpoint availability.
  await writeFile(join(f.project, 'retained'), 'preserved bytes');
  await rm(join(f.project, 'delivery'));
  await symlink('retained', join(f.project, 'delivery'));
  expect(await land(f.location, runServices(f).process, f.unitContext)).toMatchObject({ok:true,value:{state:'partial'}});
  expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
});
it('unavailable native ownership fences preservation and the SQL record-operation claim', async () => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  const worker = get(await host.beginOperation());
  try {
    get(await host.endOperation(worker.owner));
    await f.append(f.control, [{ type: 'process', receipt: { owner: worker.owner, state: 'closure_unknown', exit: null,
      signal: null, stdout: f.ref, stderr: f.ref, durationMs: 0, scope: 'group' } }]);
    await f.releaseClaims();
    const nativeKill = process.kill.bind(process);
    const denied = vi.spyOn(process,'kill').mockImplementation((pid,signal) => {
      if (pid === -worker.owner.group && signal === 0) throw Object.assign(Error('Synthetic observation denial'),{code:'EPERM'});
      return nativeKill(pid,signal);
    });
    expect(await land(f.location, runServices(f).process, f.unitContext)).toMatchObject({ ok: false,
     kind: 'unknown' });
    denied.mockRestore();
    expect((await recordOperation(f.journal, 'gc', { module: new URL("./fixtures/rewrite-native-operation.mjs", import.meta.url).href,
     method: 'touch', args: [] })).ok).toBe(false);
    expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
  }
  finally {
    await host.endOperation(worker.owner);
  }
});

it('A15 complete run reclaims workspace, pin and raw evidence once while keeping delivered bytes, events and status', async ({ task }) => {
  const { runWorkflow } = await import('../../dist-rewrite/core/loop.js');
  const { workflowFixture } = await import('../fixtures/rewrite-workflow.js');
  const { ports } = workflowFixture(f);
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect((await f.projection()).outputs.at(-1)).toMatchObject({disposition:'reviewed',detail:'Reviewed accepted delivery'});
  const captured=get(await readEvents(f.journal,0)).findLast(event=>event.payload.type==='outputs_preserved');
  expect(captured!.payload).not.toHaveProperty('receipt.disposition');
  const fs = await import('node:fs/promises');
  const bytes = async (path: string): Promise<number> => {
    const stat = await fs.lstat(path); if (!stat.isDirectory()) return stat.size;
    let total = 0; for (const entry of await fs.readdir(path)) total += await bytes(join(path, entry)); return total;
  };
  await f.releaseClaims();
  const before = await bytes(f.root), events = (await f.projection()).cursor;
  const archived=get(await land(f.location, runServices(f).process, f.unitContext));
  expect(archived.state).toBe('reclaimed');
  expect(archived.outputs).toMatchObject({disposition:'reviewed',detail:'Reviewed accepted delivery'});
  const after = await bytes(f.root), projection = await f.projection();
  expect(after).toBeLessThan(before); expect(projection.cursor).toBeGreaterThan(events);
  expect(projection.status).toBe('complete');
  expect(await readFile(join(f.location.storeRoot, 'deliveries', 'Run', 'delivery'), 'utf8')).toBe('work');
  expect(get(publishRunStatus(f.location, new Date().toISOString(), null)).reclaimed).toMatchObject({at:expect.any(String)});
  expect(get(await land(f.location, runServices(f).process, f.unitContext)).state).toBe('reclaimed');
  const { main } = await import('../../dist-rewrite/ops/main.js');
  const output: string[] = [], errors: string[] = [];
  const context = {cwd:f.root,storeRoot:f.location.storeRoot,home:f.database.slice(0,f.database.lastIndexOf('/')),
    runtimeRoot:f.root,environment:{},stdin:new Uint8Array(),abort:new AbortController().signal,
    stdout:async(bytes:Uint8Array)=>{output.push(Buffer.from(bytes).toString());},stderr:async(bytes:Uint8Array)=>{errors.push(Buffer.from(bytes).toString());}};
  expect(await main(['resume','Run'],context)).toBe(1); expect(errors.join('')).toContain('Evidence was reclaimed');
  expect(await main(['status','Run'],context),errors.join('')).toBe(0); expect(JSON.parse(output.at(-1)!).status).toBe('complete');
  task.meta.reclaim = {beforeBytes:before,afterBytes:after,reclaimedBytes:before-after};
});

it('preserves a public-cancel delivery when the invocation never crossed its start barrier', async () => {
  await checkpoint();
  const worker = get(await host.beginOperation());get(await host.endOperation(worker.owner));
  await f.append(f.control, [{ type: 'process', receipt: { owner: worker.owner, state: 'not_started', exit: null, signal: null,
    stdout: f.ref, stderr: f.ref, durationMs: 0, scope: 'group' } },
    { type: 'control_intent', intent: { id: 'CancelBeforeStart', kind: 'cancel', run: 'Run', unit: f.launch.unit,
      expectedCursor: (await f.projection()).cursor } }]);
  expect((await f.projection()).owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('dead');
  await f.releaseClaims();
  expect(get(await land(f.location, runServices(f).process, f.unitContext)).state).toBe('reclaimed');
});

it('a populated recorded pgid fences preservation when closure is still unknown', async () => {
  await checkpoint();
  const worker = get(await host.beginOperation());
  try {
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained delivery'}},
      {type:'process',receipt:{owner:worker.owner,state:'closure_unknown',exit:null,signal:null,stdout:f.ref,stderr:f.ref,durationMs:0,scope:'group'}}]);
    await f.releaseClaims();
    expect(host.groupState(worker.owner)).toBe('live');
    expect(await land(f.location,runServices(f).process,f.unitContext)).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
    expect(host.groupState(worker.owner)).toBe('live');
    expect(await readFile(join(f.project,'delivery'),'utf8')).toBe('preserved bytes');
  } finally { get(await host.endOperation(worker.owner)); }
});
it('land accepts an owner whose only receipt is closure_unknown after fresh ESRCH on its recorded group', async () => {
  await checkpoint();
  const worker = get(await host.beginOperation());
  get(await host.endOperation(worker.owner));
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained delivery'}},
    {type:'process',receipt:{owner:worker.owner,state:'closure_unknown',exit:null,signal:null,stdout:f.ref,stderr:f.ref,durationMs:0,scope:'group'}}]);
  await f.releaseClaims();
  const before = await f.projection();
  expect(get(await readEvents(f.journal,0)).flatMap(event => event.payload.type === 'process' && event.payload.receipt.owner?.authority === worker.owner.authority ? [event.payload.receipt.state] : [])).toEqual(['closure_unknown']);
  expect(before.owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('unknown');
  expect(host.groupState(worker.owner)).toBe('dead');

  const roots = [f.project,join(f.location.storeRoot,'runtime'),join(f.journal.root,'git-common')];
  const observation = vi.spyOn(process,'kill');
  let result;
  try {
    result = await land(f.location,runServices(f).process,f.unitContext);
    expect(observation).toHaveBeenCalledWith(-worker.owner.group,0);
  } finally { observation.mockRestore(); }
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{state:'reclaimed'}});
  const after = await f.projection();
  expect(after.owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('dead');
  expect(get(await readEvents(f.journal,0)).some(event => event.payload.type === 'owner_closed'
    && event.payload.owner.authority === worker.owner.authority)).toBe(true);
  expect(await readFile(join(f.location.storeRoot,'deliveries',f.location.run,'delivery'),'utf8')).toBe('preserved bytes');
  for (const root of roots) await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});
  expect((await readEvidence(f.journal,before.checkpoints.at(-1)!.manifest)).ok).toBe(false);
  expect(after.reclaimed).toMatchObject({at:expect.any(String)});
  expect(after.status).toBe('failed');
  expect(await readdir(f.journal.root)).toEqual(['status.json']);
  expect(get(publishRunStatus(f.location,new Date().toISOString(),null)).reclaimed).toEqual(after.reclaimed);
});

it.each(['work','plan'] as const)('historical command, key, checkpoint, plan and %s answer fields decode through status, list and land',async kind=>{
  const plan={...f.plan,observations:{retired:'uninterpreted'}};
  await f.close();
  f=await stateFixture({outputs:[{path:'delivery',kind:'file',existing:'replace'}]},plan);
  await f.admit();
  const cp=await checkpoint();
  const address={run:'Run',stage:'work',attempt:'Historical',invocation:1};
  const historicalAnswer=kind==='work'?{kind,answer:{status:'delivered',summary:'Historical work',caveats:[],remainingWork:[],blocks:null}}
    :{kind,answer:{baseRevision:'Revision',plan:f.plan}};
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...address}}},
    {type:'attempt_settled',receipt:{address,ending:'delivered',before:cp.tree,after:cp.tree,audit:f.ref,closure:'dead',
      usage:{state:'unknown',raw:[]},evidence:[],inputChars:0,answer:historicalAnswer} as never}]);
  const { reserveCommand, commitCommand, withState, readProjection } = await import('../../dist-rewrite/records/state.js');
  const key = {tree:cp.tree,declaration:cp.tree,context:cp.tree,inputHashes:[]};
  const reservation = get(await reserveCommand(f.execution,(await f.projection()).cursor,'HistoricalCommand',key,
    {charge:'command',address:{kind:'final',run:'Run'}}));
  get(await commitCommand(f.execution,(await f.projection()).cursor,reservation,{command:'HistoricalCommand',key,
    before:cp.tree,after:cp.tree,delta:f.ref,stdout:f.ref,stderr:f.ref,execution:{state:'complete',exit:0},spent:{durationMs:0}}));
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'incomplete',reason:'outputs_unpreserved',detail:'Retained historical delivery'}}]);
  // Emulate bytes written before retirement, including indexed current facts. Appending today would strip the keys first.
  get(withState(f.database,true,db=>{
    const inject = (value: any, kind: string) => {
      if(kind==='command') {value.observed={retired:true};value.key.observation=['ignored'];}
      if(kind==='reservation') {value.key.observation=null;if(value.receipt){value.receipt.observed=17;value.receipt.key.observation={retired:true};}}
      if(kind==='checkpoint') value.observed=['ignored'];
      if(kind==='revision') value.plan.observations={retired:true};
      if(kind==='attempt'||kind==='received') if(value.answer){value.answer.answer.observations={retired:true};if(value.answer.kind==='plan')value.answer.answer.plan.observations={retired:true};}
      return value;
    };
    for(const row of db.prepare('SELECT kind,key,value FROM current_rows WHERE root=?').all(f.journal.root))
      db.prepare('UPDATE current_rows SET value=? WHERE root=? AND kind=? AND key=?')
        .run(JSON.stringify(inject(JSON.parse(String(row.value)),String(row.kind))),f.journal.root,row.kind,row.key);
    const current=JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current));
    current.plan.plan.observations={retired:true};current.launch.plan.observations=null;
    const historicalCommand=inject(JSON.parse(String(db.prepare("SELECT value FROM current_rows WHERE root=? AND kind='command'").get(f.journal.root)!.value)),'command');
    current.launch.setup.commands=[historicalCommand];
    db.prepare('UPDATE runs SET current=? WHERE root=?').run(JSON.stringify(current),f.journal.root);
    for(const row of db.prepare('SELECT seq,payload FROM events WHERE root=?').all(f.journal.root)) {
      const payload=JSON.parse(String(row.payload));
      if(payload.type==='command') inject(payload.receipt,'command');
      if(payload.type==='checkpoint') inject(payload.checkpoint,'checkpoint');
      if(payload.type==='plan_committed') inject(payload.plan,'revision');
      if(payload.type==='attempt_settled') inject(payload.receipt,'attempt');
      db.prepare('UPDATE events SET payload=? WHERE root=? AND seq=?').run(JSON.stringify(payload),f.journal.root,row.seq);
    }
    return {ok:true,value:true};
  }));
  const rawKeys=get(withState(f.database,false,db=>({ok:true,value:db.prepare('SELECT payload FROM events WHERE root=?').all(f.journal.root).map(row=>String(row.payload)).join('')})));
  expect(rawKeys).toContain('"observed"');expect(rawKeys).toContain('"observation"');expect(rawKeys).toContain('"observations"');
  const decoded=get(await readProjection(f.journal));
  expect(decoded.commands).toHaveLength(1);
  expect(decoded.commands[0]).not.toHaveProperty('observed');
  expect(decoded.launch.setup.commands[0]).not.toHaveProperty('observed');
  expect(decoded.launch.setup.commands[0].key).not.toHaveProperty('observation');
  expect(decoded.commands[0].key).not.toHaveProperty('observation');
  expect(decoded.checkpoints[0]).not.toHaveProperty('observed');
  expect(decoded.plan.plan).not.toHaveProperty('observations');
  expect(decoded.revisions[0].plan).not.toHaveProperty('observations');
  expect(decoded.attempts[0].answer!.answer).not.toHaveProperty('observations');
  await f.releaseClaims();
  const {main}=await import('../../dist-rewrite/ops/main.js');
  const output:string[]=[], diagnostics:string[]=[];
  const context={cwd:f.root,storeRoot:f.location.storeRoot,home:f.database.slice(0,f.database.lastIndexOf('/')),
    runtimeRoot:f.root,environment:{},stdin:new Uint8Array(),abort:new AbortController().signal,
    stdout:async(bytes:Uint8Array)=>{output.push(Buffer.from(bytes).toString());},stderr:async(bytes:Uint8Array)=>{diagnostics.push(Buffer.from(bytes).toString());}};
  expect(await main(['status','Run'],context),diagnostics.join('')).toBe(0);
  expect(await main(['status'],context)).toBe(0);
  expect(output.join('')).toContain('Run');
  expect(get(await land(f.location,runServices(f).process,f.unitContext)).state).toBe('reclaimed');
  expect(await readFile(join(f.location.storeRoot,'deliveries','Run','delivery'),'utf8')).toBe('preserved bytes');
});

it.each(['absent','quarantined'] as const)('land retains current bytes with an %s checkpoint and an unusable pin',async checkpointState=>{
  await writeFile(join(f.project,'delivery'),'current unreviewed bytes');
  if(checkpointState==='quarantined') {
    const cp=get(await captureCheckpoint(f.scope,{run:'Run',stage:'work',attempt:'Unsafe',invocation:1},null,'quarantined',[],get(await settleFrozenInputs(f.scope)).inputs));
    await f.append(f.execution,[{type:'checkpoint',checkpoint:cp}]);
    await writeFile(join(f.project,'delivery'),'current unreviewed bytes');
  }
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'cancelled author'}}]);
  await f.releaseClaims();
  if(checkpointState==='absent')await rm(join(f.location.storeRoot,'runtime'),{recursive:true});
  else {
    await chmod(join(f.location.storeRoot,'runtime','.pin'),0o644);
    await writeFile(join(f.location.storeRoot,'runtime','.pin'),'unusable pin');
  }
  const {main}=await import('../../dist-rewrite/ops/main.js');
  const output:string[]=[],errors:string[]=[];
  const context={cwd:f.root,home:f.database.slice(0,f.database.lastIndexOf('/')),storeRoot:f.location.storeRoot,
    runtimeRoot:f.root,environment:{},stdin:new Uint8Array(),abort:new AbortController().signal,
    stdout:async(bytes:Uint8Array)=>{output.push(Buffer.from(bytes).toString());},stderr:async(bytes:Uint8Array)=>{errors.push(Buffer.from(bytes).toString());}};
  expect(await main(['land','Run'],context),errors.join('')).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({state:'reclaimed',outputs:{disposition:'unreviewed',detail:'Unreviewed retained observation'}});
  expect(await readFile(join(f.location.storeRoot,'deliveries','Run','delivery'),'utf8')).toBe('current unreviewed bytes');
  expect(await main(['land','Run'],context),errors.join('')).toBe(0);
  expect((await f.projection()).status).toBe('cancelled');
});

it('reclaim retries after partial GC has removed workspace, runtime, scratch parents and raw evidence',async()=>{
  await checkpoint();
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'cancelled',reason:'cancelled',detail:'Retained cancelled work'}}]);
  await f.releaseClaims();
  const runOperation=host.runOperation;
  const interrupted=vi.spyOn(host,'runOperation').mockImplementation(async(request,...args)=>{
    if(request.method!=='reclaimTask')return runOperation(request,...args);
    for(const path of [f.project,join(f.location.storeRoot,'runtime'),join(f.location.storeRoot,'work'),join(f.journal.root,'git-common')])
      await rm(path,{recursive:true,force:true});
    return {ok:false,kind:'unavailable',detail:'Synthetic interruption after deleting reclaim directories'};
  });
  expect(await land(f.location,runServices(f).process,f.unitContext)).toMatchObject({ok:false,kind:'unavailable'});
  interrupted.mockRestore();
  const partial=await f.projection();
  expect(partial.reclaimed).toBeDefined();
  const retried=get(await land(f.location,runServices(f).process,f.unitContext));
  expect(retried).toMatchObject({state:'reclaimed',delivery:partial.reclaimed!.delivery,outputs:partial.outputs.at(-1)});
  expect(get(await land(f.location,runServices(f).process,f.unitContext))).toEqual(retried);
  expect(await readFile(join(retried.delivery!,'delivery'),'utf8')).toBe('preserved bytes');
});

it('an ended run reports the bytes it holds once, carries them forward unchanged, and drops them when landed', async () => {
  const publish = () => get(publishRunStatus(f.location, new Date().toISOString(), null));
  await checkpoint();
  expect(publish().heldBytes).toBeUndefined(); // a run that has not ended holds nothing to report
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'ended' } }]);
  await f.releaseClaims();
  const ended = publish().heldBytes;
  expect(ended).toBeGreaterThan(Buffer.byteLength('preserved bytes'));
  await writeFile(join(f.project, 'grown-later'), 'x'.repeat(4096));
  expect(publish().heldBytes).toBe(ended); // measured once, not on every publication
  get(await land(f.location, runServices(f).process, f.unitContext));
  expect(publish()).toMatchObject({ reclaimed: { at: expect.any(String) } });
  expect(publish().heldBytes).toBeUndefined();
});

it('what land removes is exactly what the held-bytes measurement counts: reclaimTargets and rawEvidence', async () => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'ended' } }]);
  await f.releaseClaims();
  const targets = Object.values(reclaimTargets(f.location.storeRoot, f.location.run, (await f.projection()).launch!));
  const evidence = rawEvidence(f.journal.root);
  const before = await readdir(f.journal.root);
  expect(evidence.length).toBeGreaterThan(0);
  // Independent byte count (not held.ts): every file under the fixture's root, hard links once, leaving out what land itself
  // writes (the run's status snapshot, the state database, delivered outputs). Its drop across land must equal heldBytes.
  const kept = [join(f.journal.root, 'status.json'), join(f.location.storeRoot, 'deliveries'), dirname(f.location.database)];
  const storeBytes = () => {
    const seen = new Set<string>(); let total = 0;
    const walk = (path: string) => {
      if (kept.some(skip => path === skip || path.startsWith(skip + '/'))) return;
      let info; try { info = lstatSync(path); } catch { return; }
      if (info.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
      const id = `${info.dev}:${info.ino}`; if (seen.has(id)) return; seen.add(id); total += info.size;
    };
    walk(f.root);
    return total;
  };
  const held = heldBytes(f.location.storeRoot, f.location.run, (await f.projection()).launch!);
  const storeBefore = storeBytes();
  expect(held).toBeGreaterThan(0);
  get(await land(f.location, runServices(f).process, f.unitContext));
  expect(storeBefore - storeBytes()).toBe(held);
  for (const path of [...targets, ...evidence]) await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  // Independently of the owner: the entries that vanished from the record directory are exactly the counted ones.
  const after = await readdir(f.journal.root);
  expect(before.filter(name => !after.includes(name)).sort()).toEqual(evidence.map(path => path.slice(f.journal.root.length + 1)).sort());
  expect(after).toEqual(['status.json']);
});
