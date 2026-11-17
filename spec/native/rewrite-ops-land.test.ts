import { publishRunStatus } from '../../dist-rewrite/ops/status.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { access, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as host from "../../dist-rewrite/host/process.js";
import { land } from "../../dist-rewrite/ops/land.js";
import { captureCheckpoint } from "../../dist-rewrite/records/content.js";
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
 const cp = get(await captureCheckpoint(f.scope, { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, null, 'safe', []));
 await f.append(f.execution, [{ type: 'checkpoint', checkpoint: cp }]); return cp; }
it.each(['preserve', 'reclaim'] as const)('uses real content and SQL to %s a closed delivery', async (mode) => {
  const cp = await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'incomplete', reason: 'outputs_unpreserved',
   detail: 'retained work' } }]);
  await f.releaseClaims();
  const report = get(await land(f.location, mode, runServices(f).process, f.unitContext));
  expect(report.state).toBe(mode === 'preserve' ? 'preserved' : 'reclaimed');
  expect(report.outputs.artifacts).toHaveLength(1);
  if (mode === 'preserve') {
    const artifact = JSON.parse(Buffer.from(get(await readEvidence(f.journal, report.outputs.artifacts[0]))).toString());
    expect(artifact).toMatchObject({ path: 'delivery', snapshot: { kind: 'file', sha256: digest('preserved bytes') } });
    expect((await readEvidence(f.journal, cp.manifest)).ok).toBe(true);
  } else {
    expect((await readEvidence(f.journal, cp.manifest)).ok).toBe(false);
    expect(await readFile(join(f.location.storeRoot, 'deliveries', f.location.run, 'delivery'), 'utf8')).toBe('preserved bytes');
    await expect(access(join(f.journal.root, 'git-common'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(f.location.storeRoot, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(get(publishRunStatus(f.location, new Date().toISOString(), null)).reclaimed).toMatchObject({ at: expect.any(String) });
    expect(get(await land(f.location, mode, runServices(f).process, f.unitContext)).state).toBe('reclaimed');
  }
  expect((await f.projection()).status).toBe('incomplete');
  if (mode === 'preserve')
    expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
  else
    await expect(access(f.project)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each((['preserve', 'reclaim'] as const).flatMap(mode => (['active', 'unknown'] as const).map(state => [mode,
 state] as const)))('refuses %s with %s manager ownership before destructive work', async (mode, state) => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  await f.releaseClaims();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state, owner: null, evidence: [], detail: '' } });
  expect(await land(f.location, mode, runServices(f).process, f.unitContext)).toMatchObject({ ok: false,
   kind: state === 'active' ? 'conflict' : 'unknown', detail: state === 'active' ? 'Run unit is active' : 'Run unit state unknown' });
  expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
});
it('settles interrupted reservations as closed-unmeasured after confirmed closure', async () => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'command', address: { kind: 'final', run: 'Run' } } },
   { type: 'command_reserved', reservation: { identity: 'Check', state: 'reserved', key: { tree: 'a'.repeat(64), declaration: 'a'.repeat(64),
   context: 'a'.repeat(64), inputHashes: [] }, invocation: { charge: 'command', address: { kind: 'final', run: 'Run' } } } }, {
   type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  await f.releaseClaims();
  expect(await land(f.location, 'preserve', runServices(f).process, f.unitContext)).toMatchObject({ ok: true, value: {state:'preserved'} });
  expect((await f.projection()).reservations[0]).toMatchObject({state:'closed-unmeasured'});
  expect((await f.projection()).commands).toEqual([]);
  expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
});
import { recordOperation, readEvents } from "../../dist-rewrite/records/state.js";
it('preservation failure before archive never deletes the project', async () => {
  const cp = await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'retained' } }]);
  await f.releaseClaims();
  // Remove only the selected immutable manifest; keep its captured worktree bytes.
  const oid = cp.manifest.path.split('/').at(-1)!;
  const { rm } = await import('node:fs/promises');
  await rm(join(f.journal.root, 'git-common', 'objects', oid.slice(0, 2), oid.slice(2)));
  expect((await land(f.location, 'reclaim', runServices(f).process, f.unitContext)).ok).toBe(false);
  expect(await readFile(join(f.project, 'delivery'), 'utf8')).toBe('preserved bytes');
});
it.each((['preserve','reclaim'] as const).flatMap(mode => (['live','unknown'] as const).map(state => [mode,state] as const)))(
  '%s refuses a %s owner before preservation or deletion', async (mode,state) => {
  await checkpoint();
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'failed', reason: 'attempt_failed', detail: 'terminal fixture' } }]);
  const worker = get(await host.beginOperation());
  try {
    if (state === 'live')
      await f.append(f.control, [{ type: 'ownership', owner: worker.owner, state: 'live' }]);
    else {
      get(await host.endOperation(worker.owner));
      await f.append(f.control, [{ type: 'process', receipt: { owner: worker.owner, state: 'closure_unknown', exit: null,
       signal: null, grant: 'applied', stdout: f.ref, stderr: f.ref, durationMs: 0, scope: 'group' } }]);
    }
    await f.releaseClaims();
    const nativeKill = process.kill.bind(process);
    const denied = state === 'unknown' ? vi.spyOn(process,'kill').mockImplementation((pid,signal) => {
      if (pid === -worker.owner.group && signal === 0) throw Object.assign(Error('Synthetic observation denial'),{code:'EPERM'});
      return nativeKill(pid,signal);
    }) : undefined;
    expect(await land(f.location, mode, runServices(f).process, f.unitContext)).toMatchObject({ ok: false,
     kind: state === 'live' ? 'conflict' : 'unknown' });
    denied?.mockRestore();
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
  const fs = await import('node:fs/promises');
  const bytes = async (path: string): Promise<number> => {
    const stat = await fs.lstat(path); if (!stat.isDirectory()) return stat.size;
    let total = 0; for (const entry of await fs.readdir(path)) total += await bytes(join(path, entry)); return total;
  };
  await f.releaseClaims();
  const before = await bytes(f.root), events = (await f.projection()).cursor;
  expect(get(await land(f.location, 'reclaim', runServices(f).process, f.unitContext)).state).toBe('reclaimed');
  const after = await bytes(f.root), projection = await f.projection();
  expect(after).toBeLessThan(before); expect(projection.cursor).toBeGreaterThan(events);
  expect(projection.status).toBe('complete');
  expect(await readFile(join(f.location.storeRoot, 'deliveries', 'Run', 'delivery'), 'utf8')).toBe('work');
  expect(get(publishRunStatus(f.location, new Date().toISOString(), null)).reclaimed).toMatchObject({at:expect.any(String)});
  expect(get(await land(f.location, 'reclaim', runServices(f).process, f.unitContext)).state).toBe('reclaimed');
  const { main } = await import('../../dist-rewrite/ops/main.js');
  const output: string[] = [], errors: string[] = [];
  const context = {cwd:f.root,storeRoot:f.location.storeRoot,home:f.database.slice(0,f.database.lastIndexOf('/')),
    runtimeRoot:f.root,environment:{},stdin:new Uint8Array(),abort:new AbortController().signal,
    stdout:async(bytes:Uint8Array)=>{output.push(Buffer.from(bytes).toString());},stderr:async(bytes:Uint8Array)=>{errors.push(Buffer.from(bytes).toString());}};
  expect(await main(['resume','Run'],context)).toBe(1); expect(errors.join('')).toContain('Evidence was reclaimed');
  expect(await main(['status','Run'],context)).toBe(0); expect(JSON.parse(output.at(-1)!).status).toBe('complete');
  task.meta.reclaim = {beforeBytes:before,afterBytes:after,reclaimedBytes:before-after};
});

it('preserves a public-cancel delivery when the invocation never crossed its start barrier', async () => {
  await checkpoint();
  const worker = get(await host.beginOperation());get(await host.endOperation(worker.owner));
  await f.append(f.control, [{ type: 'process', receipt: { owner: worker.owner, state: 'not_started', exit: null, signal: null,
    grant: 'applied', stdout: f.ref, stderr: f.ref, durationMs: 0, scope: 'group' } },
    { type: 'control_intent', intent: { id: 'CancelBeforeStart', kind: 'cancel', run: 'Run', unit: f.launch.unit,
      expectedCursor: (await f.projection()).cursor } }]);
  expect((await f.projection()).owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('dead');
  await f.releaseClaims();
  expect(get(await land(f.location, 'preserve', runServices(f).process, f.unitContext)).state).toBe('preserved');
});

it.each(['preserve','reclaim'] as const)('%s with closure_unknown and a populated recorded pgid refuses without observation injection', async mode => {
  await checkpoint();
  const worker = get(await host.beginOperation());
  try {
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained delivery'}},
      {type:'process',receipt:{owner:worker.owner,state:'closure_unknown',exit:null,signal:null,grant:'applied',stdout:f.ref,stderr:f.ref,durationMs:0,scope:'group'}}]);
    await f.releaseClaims();
    expect(host.groupState(worker.owner)).toBe('live');
    expect(await land(f.location,mode,runServices(f).process,f.unitContext)).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
    expect(host.groupState(worker.owner)).toBe('live');
    expect(await readFile(join(f.project,'delivery'),'utf8')).toBe('preserved bytes');
  } finally { get(await host.endOperation(worker.owner)); }
});
it.each(['preserve','reclaim'] as const)('%s accepts an owner whose only receipt is closure_unknown after fresh ESRCH on its recorded group', async mode => {
  await checkpoint();
  const worker = get(await host.beginOperation());
  get(await host.endOperation(worker.owner));
  await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'failed',reason:'attempt_failed',detail:'Retained delivery'}},
    {type:'process',receipt:{owner:worker.owner,state:'closure_unknown',exit:null,signal:null,grant:'applied',stdout:f.ref,stderr:f.ref,durationMs:0,scope:'group'}}]);
  await f.releaseClaims();
  const before = await f.projection();
  expect(get(await readEvents(f.journal,0)).flatMap(event => event.payload.type === 'process' && event.payload.receipt.owner?.authority === worker.owner.authority ? [event.payload.receipt.state] : [])).toEqual(['closure_unknown']);
  expect(before.owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('unknown');
  expect(host.groupState(worker.owner)).toBe('dead');
  const roots = [f.project,join(f.location.storeRoot,'runtime'),join(f.journal.root,'git-common')];
  const retained = await Promise.all(roots.map(async root => [root,await readdir(root,{recursive:true})] as const));
  const observation = vi.spyOn(process,'kill');
  let result;
  try {
    result = await land(f.location,mode,runServices(f).process,f.unitContext);
    expect(observation).toHaveBeenCalledWith(-worker.owner.group,0);
  } finally { observation.mockRestore(); }
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{state:mode === 'preserve' ? 'preserved' : 'reclaimed'}});
  const after = await f.projection();
  expect(after.owners.find(entry => entry.owner.authority === worker.owner.authority)?.state).toBe('dead');
  expect(get(await readEvents(f.journal,0)).some(event => event.payload.type === 'owner_closed'
    && event.payload.owner.authority === worker.owner.authority)).toBe(true);
  if (mode === 'reclaim') {
    expect(await readFile(join(f.location.storeRoot,'deliveries',f.location.run,'delivery'),'utf8')).toBe('preserved bytes');
    for (const root of roots) await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});
    expect((await readEvidence(f.journal,before.checkpoints.at(-1)!.manifest)).ok).toBe(false);
    expect(after.reclaimed).toMatchObject({at:expect.any(String)});
    expect(after.status).toBe('failed');
    expect(await readdir(f.journal.root)).toEqual(['status.json']);
    expect(get(publishRunStatus(f.location,new Date().toISOString(),null)).reclaimed).toEqual(after.reclaimed);
    return;
  }
  expect(await readFile(join(f.project,'delivery'),'utf8')).toBe('preserved bytes');
  await access(join(f.location.storeRoot,f.launch.runtime.path));
  expect((await readEvidence(f.journal,before.checkpoints.at(-1)!.manifest)).ok).toBe(true);
  expect((await f.projection()).reclaimed).toBeUndefined();
  for (const [root,entries] of retained) expect(await readdir(root,{recursive:true})).toEqual(expect.arrayContaining(entries));
});
