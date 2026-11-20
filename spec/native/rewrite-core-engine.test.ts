import { f, answerReceipt, resetFixture, stage } from './fixtures/rewrite-core.js';
import { expect, it, vi } from 'vitest';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { join } from 'node:path';
import { endOperation, type Claim } from '../../dist-rewrite/host/process.js';
import { appendEvents, claim, openWriter, release, putEvidence, readEvents, readAdvisoryActivity } from '../../dist-rewrite/records/state.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';

it('drives real SQL/content through work, independent review and final publication', async () => {
  const { ports, seen } = workflowFixture(f);
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'complete', reason: 'completed' });
  const p = await f.projection();
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'gate']);
  expect(p.status).toBe('complete');
  expect(p.attempts).toHaveLength(2);
  expect(p.checkpoints).toHaveLength(2);
  expect(p.transitions).toHaveLength(1);
  expect(p.outputs[0].preserved).toBe(true);
  expect(p.intervals.every(i => i.spentMs !== null)).toBe(true);
  expect(p).not.toHaveProperty('activity');
  expect(get(await readEvents(f.journal,0)).some(event=>['command_activity','execution_activity'].includes(event.payload.type))).toBe(false);
});
it('returns retained rejection to its repair stage and then the same gate', async () => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let first = true;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.purpose !== 'gate' || !first)
      return { ok: true, value: r };
    first = false;
    const answer = { kind: 'gate' as const, answer: { outcome: 'rejected_repairable' as const, reason: 'Repair the delivery',
     criteria: { correct: { status: 'fail' as const, evidence: 'Needs repair' } }, findings: [{ id: 'finding', paths: [], reason: 'Correctness',
     criterionIds: ['correct'], class: 'criterion_unmet' as const }], remainingWork: ['Repair'] } };
    return { ok: true, value: { ...r, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) } };
  };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'gate', 'repair', 'gate']);
  expect((await f.projection()).transitions.map(t => t.outcome)).toEqual(['rejected_repairable', 'accepted']);
});
it('retains late raw answer after real cancel without releasing dependencies', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const receipt = get(await native(request)); const p = await f.projection();
   await f.append(f.control, [{ type: 'control_intent', intent: { id: 'Cancel', kind: 'cancel', run: 'Run', unit: f.launch.unit,
   expectedCursor: p.cursor } }]); return { ok: true, value: receipt }; };
  await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
  const p = await f.projection();
  expect(p.status).toBe('cancelled');
  expect(p.attempts).toHaveLength(1);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
  expect(p.transitions).toEqual([]);
});
it.each(['quota', 'closure_unknown'] as const)('parks %s with durable evidence and no redispatch', async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (r) => { const receipt = get(await native(r)); return { ok: true, value: { ...receipt, ending, answer: undefined,
   answerRef: undefined, ...(ending === 'closure_unknown' ? { closure: 'unknown' as const } : {}) } }; };
  await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
  const p = await f.projection();
  expect(p.status).toBe('parked');
  expect(seen).toHaveLength(1);
  expect(p.attempts[0].ending).toBe(ending);
  if (ending === 'closure_unknown') {
    expect(p.conclusion?.detail).toContain('unknown: Descendant closure not proven');
    expect(p.conclusion?.detail).toContain('diagnostic git/objects/');
  }
});
it.each(['invalid_answer'] as const)('retains a failed %s attempt before an actual successful retry',
 async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let first = true;
  ports.attempt = async (request) => { const r = get(await native(request)); if (!first)
    return { ok: true, value: r }; first = false; return { ok: true, value: { ...r, ending, answer: undefined, answerRef: undefined } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  const p = await f.projection();
  expect(p.attempts[0].ending).toBe(ending);
  expect(p.attempts).toHaveLength(3);
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'work', 'gate']);
});
it('does not dispatch through an actual unresolved command reservation', async () => {
  await resetFixture({ commands: [{ id: 'Check', argv: ['fixture'], env: {}, inputs: [], required: true }] });
  const p = await f.projection(), invocation = { charge: 'command' as const, address: { kind: 'final' as const, run: 'Run' } };
  const { reserveCommand } = await import('../../dist-rewrite/records/state.js');
  get(await reserveCommand(f.execution, p.cursor, 'Check', { tree: 'a'.repeat(64), context: 'b'.repeat(64), declaration: 'c'.repeat(64),
   inputHashes: [] }, invocation));
  const { ports, seen } = workflowFixture(f);
  expect(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).toMatchObject({
   ok: false, kind: 'unknown' });
  expect(seen).toEqual([]);
});
it('runs required commands omitted by the planner inside the delivery gate phase', async () => {
  await resetFixture({ commands: [{ id: 'Check', argv: ['fixture'], env: {}, inputs: [], required: true }] });
  const { ports, seen } = workflowFixture(f);
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'complete', reason: 'completed' });
  const p = await f.projection();
  expect(p.commands.map(receipt => receipt.command)).toEqual(['Check']);
  expect(p.reservations[0]).toMatchObject({state:'committed',invocation:{address:{kind:'stage',...p.attempts.at(-1)!.address}}});
  expect(p.plan.plan.stages.find(stage => stage.id === p.attempts.at(-1)!.address.stage)?.commands).toEqual([]);
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(1);
  expect(p.backstop.failureSuffix).toBe(0);
});
it.each(['provider_unknown'] as const)('an unaccepted %s ending retains a rejected gate as evidence without changing C2', async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; return { ok: true, value: { ...await answerReceipt(r, { kind: 'gate', answer: {
     outcome: 'rejected_irreparable', reason: 'Unaccepted terminal envelope', criteria: { correct: { status: 'fail',
     evidence: 'Retained answer' } }, findings: [], remainingWork: [] } }), ending } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('parked');
  expect((await f.projection()).backstop).toMatchObject({ gateSuffix: 0, failureSuffix: 0, bestPassCount: null });
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(1);
});

async function acceptGuide(id='Guide',text='Answer with the operator correction') {
  const p=await f.projection();
  const content=get(await putEvidence(f.journal,Buffer.from(text)));
  await f.append(f.control,[{type:'control_intent',intent:{id,kind:'guide',run:p.run,unit:p.launch.unit,expectedCursor:p.cursor,
    intervention:{kind:'guide',address:(()=>{const current=p.invocations.filter(item=>item.charge !== 'command').at(-1)?.address;
      if(!current || current.kind !== 'stage')return null;const {kind:_kind,...address}=current;return address;})(),content}}}]);
}
async function observed(probe:()=>Promise<boolean>, fact='live consumer') {
  for(let i=0;i<2000;i++) {if(await probe()) return;await new Promise(resolve=>setTimeout(resolve,1));}
  throw new Error(`Observation did not reach ${fact}`);
}
it('steers an accepted guide into the running author and publishes tool progress before exit',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    const {ports,seen}=workflowFixture(f),native=ports.attempt;
    let correction='';
    ports.attempt=async request=>{
      if(request.stage.purpose !== 'gate') {
        request.live!.onLive!({steer:async text=>{correction+=(correction ? '; ' : '')+text;return 'delivered';}});
        request.live!.onActivity!({kind:'tool-start',at:ports.now().at,tool:'Bash',summary:'npm test'});
        await acceptGuide();await acceptGuide('NextGuide','Keep the exact API');
        await vi.advanceTimersByTimeAsync(5000);
        await observed(async()=>correction === 'Answer with the operator correction; Keep the exact API','native guide delivery');
        expect((await f.projection()).guideDeliveries).toEqual([]);
        await observed(async()=>!!get(await ports.publishStatus(ports.now(),0)).activity?.some(item=>item.state === 'current' && item.summary === 'npm test'),'activity before author exit');
        expect(correction).toBe('Answer with the operator correction; Keep the exact API');
      }
      const receipt=get(await native(request));
      return {ok:true,value:request.stage.purpose === 'gate' ? receipt : await answerReceipt(receipt,{kind:'work',answer:{
        status:'delivered',summary:correction,caveats:[],remainingWork:[],blocks:null}})};
    };
    expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).status).toBe('complete');
    expect(seen.map(r=>r.stage.id)).toEqual(['work','gate']);
    const p=await f.projection();
    expect(p.attempts[0].answer).toMatchObject({answer:{summary:'Answer with the operator correction; Keep the exact API'}});
    expect(p.attempts[0].guidance).toEqual(['Guide','NextGuide']);
    expect(get(await readEvents(f.journal,0)).some(event=>event.payload.type === 'guide_delivered')).toBe(false);
    expect(p.guideDeliveries).toEqual([{guide:'Guide',invocation:p.attempts[0].address},{guide:'NextGuide',invocation:p.attempts[0].address}]);
    expect(get(await ports.publishStatus(ports.now(),0)).guidance).toMatchObject([{guide:'Guide',state:'delivered',invocation:p.attempts[0].address},{guide:'NextGuide',state:'delivered',invocation:p.attempts[0].address}]);
    expect(seen.filter(r=>r.stage.purpose === 'gate').every(r=>!r.guidance?.length)).toBe(true);
  } finally {vi.useRealTimers();}
});
it.each(['refused','ended'] as const)('keeps %s steering pending for the author continuation input',async outcome=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    const {ports,seen}=workflowFixture(f),native=ports.attempt;let offered=0;
    ports.attempt=async request=>{
      if(request.stage.id === 'work' && !offered) {
        request.live!.onLive!({steer:async()=>{offered++;return offered === 1 ? 'delivered' : outcome;}});
        await acceptGuide('LiveGuide');
        await acceptGuide();await vi.advanceTimersByTimeAsync(5000);await observed(async()=>offered === 2);
        expect((await f.projection()).guideDeliveries).toEqual([]);
      }
      return native(request);
    };
    expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).status).toBe('complete');
    expect(seen.map(r=>r.stage.id)).toEqual(['work','work','gate']);
    expect(seen[1].guidance?.map(g=>g.intent)).toEqual(['Guide']);
    expect((await f.projection()).guideDeliveries).toEqual([{guide:'LiveGuide',invocation:seen[0].address},{guide:'Guide',invocation:seen[1].address}]);
  } finally {vi.useRealTimers();}
});
it('retains the returned receipt and acknowledged guidance when a later live steer throws',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    const {ports,seen}=workflowFixture(f),native=ports.attempt;let offers=0;
    ports.attempt=async request=>{
      request.live!.onLive!({steer:async()=>{
        if(++offers === 1) return 'delivered';
        throw Error('Authored native steer failure');
      }});
      await acceptGuide('Delivered');await acceptGuide('Pending');
      await vi.advanceTimersByTimeAsync(5000);await observed(async()=>offers === 2);
      return native(request);
    };
    expect(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))
      .toMatchObject({ok:false,kind:'unknown',detail:'Authored native steer failure'});
    expect(seen).toHaveLength(1);
    const p=await f.projection();
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0].guidance).toEqual(['Delivered']);
    expect(get(await ports.publishStatus(ports.now(),0)).guidance).toEqual([
      {guide:'Delivered',state:'delivered',invocation:p.attempts[0].address},
      {guide:'Pending',state:'pending'}]);
  } finally {vi.useRealTimers();}
});

it('guidance accepted when only the gate remains forces one author continuation and a fresh review',async()=>{
  const {ports,seen}=workflowFixture(f),native=ports.attempt;let submitted=false;
  ports.attempt=async request=>{
    const receipt=await native(request);
    if(request.stage.purpose === 'gate' && !submitted) {submitted=true;await acceptGuide();}
    return receipt;
  };
  const result=await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal});
  expect(result).toMatchObject({ok:true,value:{status:'complete'}});
  expect(seen.map(r=>r.stage.id)).toEqual(['work','gate','work','gate']);
  expect(seen[2].guidance?.map(g=>g.intent)).toEqual(['Guide']);
  expect(seen.filter(r=>r.stage.purpose === 'gate').every(r=>!r.guidance?.length)).toBe(true);
  expect(get(await ports.publishStatus(ports.now(),0)).guidance?.every(guide=>guide.state === 'delivered')).toBe(true);
});

it('a guide accepted through the clock port between the finish read and append continues before completion',async()=>{
  const {ports,seen}=workflowFixture(f),publish=ports.publishStatus,clock=ports.now;
  const content=get(await putEvidence(f.journal,Buffer.from('Finish with the correction')));
  let armed=false,acceptedPublications=0,submitted:ReturnType<typeof appendEvents>|undefined;
  ports.publishStatus=async(...args)=>{
    const status=await publish(...args);
    if(!submitted && (await f.projection()).transitions.some(transition=>transition.outcome === 'accepted'))
      armed=++acceptedPublications === 2;
    return status;
  };
  ports.now=()=>{
    const reading=clock();
    if(armed && !submitted) {
      armed=false;
      // appendEvents reaches its synchronous SQL transaction before returning the promise.
      submitted=appendEvents(f.control,null,[{type:'control_intent',intent:{id:'Guide',kind:'guide',run:'Run',unit:f.launch.unit,
        expectedCursor:0,intervention:{kind:'guide',address:null,content}}}]);
    }
    return reading;
  };
  const result=await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'complete'}});
  expect(submitted).toBeDefined();get(await submitted!);
  expect(seen.map(request=>request.stage.id)).toEqual(['work','gate','work','gate']);
  expect(seen[2].guidance?.map(guide=>guide.intent)).toEqual(['Guide']);
  const projection=await f.projection();
  expect(projection.guideDeliveries).toEqual([{guide:'Guide',invocation:seen[2].address}]);
  expect(get(await readEvents(f.journal,0)).filter(event=>event.payload.type === 'guide_delivered')).toEqual([]);
  expect(get(await ports.publishStatus(ports.now(),0)).guidance).toEqual([{guide:'Guide',state:'delivered',invocation:seen[2].address}]);
  expect(get(await ports.publishStatus(ports.now(),0)).activity?.find(activity=>activity.stage === 'gate')?.source).toBe('gate');
});

it('a cancel accepted through the clock port between a park read and append commits cancellation',async()=>{
  const {ports}=workflowFixture(f),native=ports.attempt,clock=ports.now;
  let receiptReturned=false,armed=false,submitted:ReturnType<typeof appendEvents>|undefined;
  ports.attempt=async request=>{
    const receipt=get(await native(request));receiptReturned=true;
    return {ok:true,value:{...receipt,ending:'quota',answer:undefined,answerRef:undefined}};
  };
  const publish=ports.publishStatus;
  ports.publishStatus=async(...args)=>{
    const result=await publish(...args);
    if(receiptReturned && (await f.projection()).attempts.length) armed=true;
    return result;
  };
  ports.now=()=>{
    const reading=clock();
    if(armed && !submitted) {
      armed=false;
      submitted=appendEvents(f.control,null,[{type:'control_intent',intent:{id:'Cancel',kind:'cancel',run:'Run',unit:f.launch.unit,expectedCursor:0}}]);
    }
    return reading;
  };
  const result=await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'cancelled',reason:'cancelled'}});
  expect(submitted).toBeDefined();get(await submitted!);
  const p=await f.projection();
  expect(p.conclusion).toMatchObject({status:'cancelled',reason:'cancelled'});
  expect(p.intervals.every(interval=>interval.spentMs !== null)).toBe(true);
});

it.each(['unknown','throw'] as const)('an advisory activity %s write failure leaves the workflow conclusion and receipts intact',async fault=>{
  const records=await import('../../dist-rewrite/records/state.js');
  const writes=vi.spyOn(records,'insertAdvisoryActivity').mockImplementation(()=>{
    if(fault === 'throw') throw Error('Authored advisory write failure');
    return {ok:false,kind:'unknown',detail:'Authored advisory write failure'};
  });
  const log=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
  const {ports,seen}=workflowFixture(f);
  try {
    expect(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))
      .toMatchObject({ok:true,value:{status:'complete'}});
    expect(writes).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Activity observation ignored:'));
    expect((await f.projection()).attempts).toHaveLength(2);
    expect(seen.map(request=>request.stage.id)).toEqual(['work','gate']);
  } finally {writes.mockRestore();log.mockRestore();}
});

it('publication returns a stale writer epoch conflict without retrying or publishing a conclusion',async()=>{
  const {withState}=await import('../../dist-rewrite/records/state.js');
  const {ports}=workflowFixture(f),publish=ports.publishStatus;
  let revoked=false,publications=0;
  ports.publishStatus=async(...args)=>{
    publications++;
    if(publications>30) throw Error('Publication conflict looped');
    const result=await publish(...args);
    if(!revoked && (await f.projection()).transitions.some(transition=>transition.outcome === 'accepted')) {
      revoked=true;
      get(withState(f.database,true,db=>{
        db.prepare("UPDATE epochs SET active=0 WHERE root=? AND kind='execution'").run(f.journal.root);
        return {ok:true,value:true};
      }));
    }
    return result;
  };
  expect(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))
    .toMatchObject({ok:false,kind:'conflict',detail:'Stale writer epoch'});
  expect(revoked).toBe(true);
  expect(publications).toBeLessThan(30);
  expect((await f.projection()).conclusion).toBeUndefined();
});

it('re-delivers a steered guide after its invocation dies before returning a receipt',async()=>{
  let successor:Claim|undefined;
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    const first=workflowFixture(f);let offers=0;
    first.ports.attempt=async request=>{
      request.live!.onLive!({steer:async()=>{offers++;return 'delivered';}});
      await acceptGuide();
      await vi.advanceTimersByTimeAsync(5000);
      await observed(async()=>offers === 1);
      expect((await f.projection()).guideDeliveries).toEqual([]);
      return {ok:false,kind:'unavailable',detail:'Invocation died before returning its receipt'};
    };
    expect(await runWorkflow({writer:f.execution,scope:f.scope,ports:first.ports,abort:new AbortController().signal}))
      .toMatchObject({ok:false,kind:'unavailable'});
    expect((await f.projection()).attempts).toEqual([]);
    // The old controller really closes; its successor cannot invent a receipt or delivery.
    get(await endOperation(f.execution.owner));
    await f.append(f.control,[{type:'owner_closed',owner:f.execution.owner},{type:'accounting_interrupted'}]);
    await f.retireExecution();
    successor=get(await claim(join(f.journal.root,'execution'),null,{database:f.database,holder:f.journal.root}));
    f.execution=get(await openWriter(f.journal,successor,'execution'));
    const recovered=workflowFixture(f);
    const result=await runWorkflow({writer:f.execution,scope:f.scope,ports:recovered.ports,abort:new AbortController().signal});
    expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'complete'}});
    expect(recovered.seen[0].guidance?.map(guide=>guide.intent)).toEqual(['Guide']);
    const p=await f.projection();
    expect(p.guideDeliveries).toEqual([{guide:'Guide',invocation:recovered.seen[0].address}]);
    expect(p.attempts[0].guidance).toEqual(['Guide']);
  } finally {if(successor)get(await release(successor,'retire'));vi.useRealTimers();}
});

it('author silence persists one notice per quiet episode despite chatter and clears on an event',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    const {INACTIVITY_WINDOW_MS}=await import('../../dist-rewrite/host/activity.js');
    const {ports}=workflowFixture(f),native=ports.attempt,publish=ports.publishStatus;
    let publications=0;
    ports.publishStatus=async(...args)=>{const result=await publish(...args);publications++;return result;};
    let time=Date.parse('2001-01-01T00:00:00Z');
    ports.now=()=>({at:new Date(time).toISOString(),monotonicMs:time});
    const notices=async()=>get(readAdvisoryActivity(f.journal)).filter(activity=>activity.observation === 'quiet');
    ports.attempt=async request=>{
      if(request.stage.purpose !== 'gate') {
        const event=(kind:'tool-start'|'tool-end'|'message',summary:string)=>request.live!.onActivity!({kind,at:ports.now().at,tool:kind === 'message' ? undefined : 'Bash',summary});
        const tick=async()=>{const before=publications;await vi.advanceTimersByTimeAsync(5000);await observed(async()=>publications > before,'completed observation cadence');};
        event('tool-start','npm test');
        await tick();await observed(async()=>!!get(await ports.publishStatus(ports.now(),0)).activity?.some(item=>item.summary === 'npm test'));
        time+=INACTIVITY_WINDOW_MS;event('message','unrelated provider chatter');
        await tick();await observed(async()=>(await notices()).length === 1,'first author quiet notice');
        const status=get(await ports.publishStatus(ports.now(),0));
        expect(status).toMatchObject({status:'running',stopReason:null,attention:null,activity:[{source:'author',state:'current',lastTool:'Bash',summary:'npm test',observation:'quiet'}]});
        for(let i=0;i<3;i++) {time+=5000;event('message','more chatter');await tick();}
        expect(await notices()).toHaveLength(1);
        event('tool-end','test done');await tick();
        await observed(async()=>!get(await ports.publishStatus(ports.now(),0)).activity?.some(item=>item.notice));
        expect(get(await ports.publishStatus(ports.now(),0)).attention).toBeNull();
        event('tool-start','npm run lint');await tick();
        await observed(async()=>!!get(await ports.publishStatus(ports.now(),0)).activity?.some(item=>item.summary === 'npm run lint'));
        time+=INACTIVITY_WINDOW_MS;await tick();await observed(async()=>(await notices()).length === 2);
        expect((await notices()).map(activity=>activity.notice?.cursor)[0]).not.toEqual((await notices()).map(activity=>activity.notice?.cursor)[1]);
      }
      return native(request);
    };
    expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).status).toBe('complete');
    expect(get(await ports.publishStatus(ports.now(),0)).activity?.every(item=>item.state === 'ended' && !item.notice)).toBe(true);
  } finally {vi.useRealTimers();}
});
