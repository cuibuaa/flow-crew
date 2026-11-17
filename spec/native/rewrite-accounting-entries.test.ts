import { expect, it, vi } from 'vitest';
import * as host from '../../dist-rewrite/host/process.js';
import { runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { join } from 'node:path';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
vi.mock('../../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/host/process.js')>(), observeRun:vi.fn(),
}));

it.each(['dead','live'] as const)('native unit entry distinguishes a %s predecessor while its own unit is active', async activation => {
  const f = await stateFixture(), worker = get(await host.beginOperation());
  try {
    await f.admit();
    await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Prior',owner:worker.owner,
      openedAt:new Date().toISOString(),spentMs:null}},{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
    if (activation === 'dead') get(await host.endOperation(worker.owner));
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'active',owner:null,evidence:[],detail:'New unit activation'}});
    const result = await runUnitEntry(f.location,f.launch.unit,runServices(f),new AbortController().signal);
    if (activation === 'dead') {
      expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'complete'}});
      expect((await f.projection()).intervals.find(i => i.id === 'Prior')).toMatchObject({closed:'unmeasured',spentMs:null});
      expect((await f.projection()).obligations).toEqual([]);
    } else {
      expect(result).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
      expect(host.groupState(worker.owner)).toBe('live');
      expect((await f.projection()).status).toBe('running');
      expect((await f.projection()).intervals).toEqual([expect.objectContaining({id:'Prior',spentMs:null})]);
    }
  } finally { get(await host.endOperation(worker.owner)); await f.close(); }
});

it('a reconciled command gets a fresh context instead of reopening dead accounting', async () => {
  const { identifyCommand } = await import('../../dist-rewrite/exec/command.js');
  const { runWorkflow } = await import('../../dist-rewrite/core/loop.js');
  const { reserveCommand, claim, openWriter, release } = await import('../../dist-rewrite/records/state.js');
  const { reconcileRun } = await import('../../dist-rewrite/ops/reconcile.js');
  const { workflowFixture } = await import('../fixtures/rewrite-workflow.js');
  const command = {id:'Check',argv:['fixture'],env:{},inputs:[],required:true};
  const observation = {command:'Check',criterionIds:['correct'],sources:[],products:[]};
  const graph = {observations:[observation],stages:[{id:'gate',role:'author',purpose:'gate' as const,after:[],
    instruction:'Review',skills:[],commands:['Check']}]};
  const f = await stateFixture({commands:[command]},graph);
  let held;
  try {
    await f.admit();
    const key = get(await identifyCommand(command,f.scope,undefined,observation));
    await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Prior',owner:f.owner,openedAt:new Date().toISOString(),spentMs:null}}]);
    get(await reserveCommand(f.execution,(await f.projection()).cursor,'Check',key,
      {charge:'command',address:{kind:'stage',run:'Run',stage:'gate',attempt:'Prior',invocation:1}}));
    await f.releaseClaims();
    held = get(await claim(join(f.journal.root,'execution'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer = get(await openWriter(f.journal,held,'execution'));
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Closed predecessor'}});
    get(await reconcileRun(writer,runServices(f).process(writer),f.unitContext,[held],false));
    const {ports} = workflowFixture(f);
    const seen: string[] = [];
    ports.command = async request => {
      seen.push(request.key.execution!.id);
      return {ok:false,kind:'unavailable',detail:'Reached fresh command execution'};
    };
    expect(await runWorkflow({writer,scope:f.scope,ports,abort:new AbortController().signal})).toMatchObject({
      ok:false,kind:'unavailable',detail:'Reached fresh command execution'});
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(key.execution!.id);
    expect((await f.projection()).reservations.map(r => r.state).sort()).toEqual(['closed-unmeasured','uncertain']);
  } finally { if (held) get(await release(held,'retire')); await f.close(); }
});
