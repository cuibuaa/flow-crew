import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { reconcileRun } from '../../dist-rewrite/ops/reconcile.js';
import * as host from '../../dist-rewrite/host/process.js';
import { captureCheckpoint } from '../../dist-rewrite/records/content.js';
import { land } from '../../dist-rewrite/ops/land.js';
import { operateRun } from '../../dist-rewrite/ops/run.js';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
vi.mock('../../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
  observeRun: vi.fn(), stopRun: vi.fn(),
}));
it.each(['preserve', 'reclaim'] as const)('cancel settles a closed activation before immediate %s', async mode => {
  const f = await stateFixture();
  try {
    await f.admit();
    const cp = get(await captureCheckpoint(f.scope,
      { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, null, 'safe', []));
    await f.append(f.execution, [{ type: 'checkpoint', checkpoint: cp }, {
      type: 'active_time_opened', interval: { id: 'Interrupted', owner: f.execution.owner,
        openedAt: new Date().toISOString(), spentMs: null }
    }]);
    // Force the observed schedule: the activation died before it could close its interval.
    // releaseClaims proves owner death; the host seam supplies confirmed inactive closure.
    await f.releaseClaims();
    const observation = { unit: f.launch.unit, state: 'inactive' as const, owner: null,
      evidence: [], detail: 'activation confirmed closed' };
    vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: observation });
    vi.mocked(host.stopRun).mockResolvedValue({ ok: true, value: observation });
    const services = runServices(f);
    const cancelled = get(await operateRun({ location: f.location, intent: { id: 'Cancel', kind: 'cancel',
      run: 'Run', unit: f.launch.unit, expectedCursor: (await f.projection()).cursor } }, services));
    expect(cancelled.state).toBe('acknowledged');
    expect((await f.projection()).status).toBe('cancelled');
    const delivery = await land(f.location, mode, services.process, f.unitContext);
    process.stderr.write('cancel-to-land evidence ' + JSON.stringify({ mode, cancelled,
      intervals: (await f.projection()).intervals, delivery }) + '\n');
    expect(delivery).toMatchObject({ ok: true,
      value: { state: mode === 'preserve' ? 'preserved' : 'reclaimed' } });
    expect((await f.projection()).intervals).toContainEqual(expect.objectContaining({spentMs:null,closed:'unmeasured'}));
    const { publishRunStatus } = await import('../../dist-rewrite/ops/status.js');
    expect(get(publishRunStatus(f.location,new Date().toISOString(),null)).usage.activeDurationMs).toBeNull();
  } finally { vi.clearAllMocks(); await f.close(); }
});

it('surfaces a failed final interval append instead of silently returning the workflow result', async () => {
  const { runWorkflow } = await import('../../dist-rewrite/core/loop.js');
  const { workflowFixture } = await import('../fixtures/rewrite-workflow.js');
  const state = await import('../../dist-rewrite/records/state.js');
  const f = await stateFixture();
  try {
    await f.admit();
    const { ports } = workflowFixture(f);
    ports.attempt = async () => { throw Error('No attempt should start'); };
    const original = state.appendEvents;
    const append = vi.spyOn(state, 'appendEvents');
    let closing = 0;
    append.mockImplementation(async (writer, cursor, payloads) => {
      if (payloads.some(p => p.type === 'stage_settled')) return { ok: false, kind: 'unavailable', detail: 'Synthetic pre-dispatch interruption' };
      if (payloads.some(p => p.type === 'active_time_closed')) {
        closing++;
        // A real independent control writer wins the cursor between read and append.
        get(await original(f.control, null, [{type:'ownership',owner:f.execution.owner,state:'dead'}]));
      }
      return original(writer, cursor, payloads);
    });
    const result = await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
    expect(closing).toBe(1);
    expect(result).toMatchObject({ ok: false, kind: 'conflict', detail: 'Stale expected cursor' });
    expect((await f.projection()).intervals).toContainEqual(expect.objectContaining({ spentMs: null }));
    append.mockRestore();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('an interrupted accounting obligation leaves work admissible and reconciles without an invented duration', async () => {
  const { attendRun, reconcileRun } = await import('../../dist-rewrite/ops/reconcile.js');
  const { claim, openWriter, release, workAdmission } = await import('../../dist-rewrite/records/state.js');
  const { join } = await import('node:path');
  const f = await stateFixture();
  let held;
  try {
    await f.admit();
    await f.append(f.execution, [{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Interrupted',invocation:1}}},
      {type:'active_time_opened',interval:{id:'Interrupted',owner:f.execution.owner,openedAt:new Date().toISOString(),spentMs:null}}]);
    get(await attendRun(f.execution,{ok:false,kind:'unavailable',detail:'Synthetic recorder loss'}));
    expect(await f.projection()).toMatchObject({status:'running',obligations:[]});
    get(await host.endOperation(f.execution.owner));
    await f.append(f.control,[{type:'owner_closed',owner:f.execution.owner}]);
    const interrupted = await f.projection();
    expect(interrupted).toMatchObject({status:'running',obligations:[{kind:'accounting-unsettled'}]});
    expect(interrupted.conclusion).toBeUndefined();
    expect(get(workAdmission(interrupted))).toBeNull();
    await f.releaseClaims();
    const observation = {unit:f.launch.unit,state:'inactive' as const,owner:null,evidence:[],detail:'Confirmed closed'};
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    vi.mocked(host.stopRun).mockResolvedValue({ok:true,value:observation});
    held=get(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer=get(await openWriter(f.journal,held,'control'));
    get(await reconcileRun(writer,runServices(f).process(writer),f.unitContext,[held],false));
    expect(await f.projection()).toMatchObject({status:'running',obligations:[],intervals:[{spentMs:null,closed:'unmeasured'}],
      closedInvocations:[{charge:'work',address:{attempt:'Interrupted'}}]});
  } finally {if(held)get(await release(held,'handoff'));vi.restoreAllMocks();await f.close();}
});

it.each([false,true])('a real live interval owner is reconciled with stop=%s before any claim release', async stop => {
  const f = await stateFixture();
  try {
    await f.admit();
    await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Live',owner:f.owner,
      openedAt:new Date().toISOString(),spentMs:null}}]);
    const db = new DatabaseSync(f.database);
    const held = (() => { try {
      return db.prepare('SELECT * FROM resources WHERE owner IS NOT NULL ORDER BY id').all().map((r: any) => ({
        database:f.database,holder:r.holder,resource:r.path,owner:JSON.parse(r.owner),epoch:r.epoch,
        unit:r.unit ? JSON.parse(r.unit) : null}));
    } finally { db.close(); } })();
    expect(held).toHaveLength(3);
    expect(await host.probeOwner(f.owner)).toBe('live');
    const observation = {unit:f.launch.unit,state:'inactive' as const,owner:null,evidence:[],detail:'Stopped unit'};
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:observation});
    vi.mocked(host.stopRun).mockResolvedValue({ok:true,value:observation});
    const result = await reconcileRun(f.control,runServices(f).process(f.control),f.unitContext,held,stop);
    if (stop) {
      expect(result).toEqual({ok:true,value:observation});
      expect(await host.probeOwner(f.owner)).toBe('dead');
      expect((await f.projection()).intervals).toContainEqual(expect.objectContaining({id:'Live',closed:'unmeasured'}));
    } else {
      expect(result).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
      expect(await host.probeOwner(f.owner)).toBe('live');
      expect((await f.projection()).intervals[0].closed).toBeUndefined();
    }
    const check = new DatabaseSync(f.database);
    try { expect(check.prepare('SELECT count(*) AS n FROM resources WHERE owner IS NOT NULL').get()?.n).toBe(3); }
    finally { check.close(); }
  } finally { vi.clearAllMocks(); await f.close(); }
});
