import { expect, it } from 'vitest';
import type { AttemptReceipt, RunProjection } from '../dist-rewrite/contract/runtime.js';
import { nextLifecycle, acceptsGuidance, workAdmission, pendingReceipts, attemptOpen, planStageStates, appendEvents } from '../dist-rewrite/records/state.js';
import { admitPlan } from '../dist-rewrite/core/admission.js';
import { decideNext } from '../dist-rewrite/core/decisions.js';
import { decideRetry, outcomeFacts } from '../dist-rewrite/core/retry.js';
import { sqlFixture, get } from './fixtures/rewrite-sql.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';

// Tables declare only facts read by their decision owner. Historical park labels
// and phase names are not inputs to lifecycle or graph admission.
it.each([
  ['pending', null, false, 'admit'],
  ['running', null, false, 'admit'],
  ['parked', null, false, 'retain'],
  ['pending', 'closure-unconfirmed', false, 'refuse'],
  ['pending', 'claim-unreleased', false, 'refuse'],
  ['pending', 'accounting-unsettled', false, 'admit'],
  ['running', null, true, 'refuse'],
] as const)('work admission: status=%s obligation=%s cancel=%s → %s', (status, obligation, cancel, expected) => {
  const p = coreProjection();
  p.status = status;
  p.conclusion = status === 'parked' ? {status, reason:'backstop', detail:'C2 failure suffix reached 4'} : undefined;
  p.obligations = obligation ? [{kind:obligation, detail:'Unresolved ownership', members:[]}] : [];
  p.intents = cancel ? [{id:'Cancel',kind:'cancel',run:p.run,unit:p.launch.unit,expectedCursor:p.cursor}] : [];
  const result = workAdmission(p);
  expect(result).toEqual(expected === 'refuse'
    ? {ok:false,kind:'conflict',detail:'Run cannot start work before lifecycle and obligations permit it'}
    : {ok:true,value:expected === 'retain' ? p.conclusion : null});
});

it.each([
  ['pending', ['replacement','review'], 'skipped'],
  ['settled', ['work','review'], 'settled'],
] as const)('human plan replacement: previousState=%s → stages=%j retiredState=%s',
 async (previousState, expectedStages, expectedState) => {
  const p = coreProjection();
  if (previousState === 'settled') p.stageStates = p.stageStates.map(s => s.stage === 'work' ? {...s,state:'settled',completed:true} : s);
  const proposal = {stages:[
    ...(previousState === 'settled' ? [] : [{id:'replacement',role:'author',purpose:'work' as const,after:[],instruction:'New pending work',skills:[]}]),
    {id:'review',role:'author',purpose:'gate' as const,after:[previousState === 'settled' ? 'work' : 'replacement'],commands:[]},
  ]};
  const intent = {id:'Guide',kind:'guide' as const,run:p.run,unit:p.launch.unit,expectedCursor:p.cursor,
    intervention:{kind:'guide' as const,address:null,content:p.brief.bytes,replacement:{baseRevision:p.plan.revision,plan:proposal}}};
  const admitted = get(await admitPlan({root:'/synthetic',database:'/synthetic/state.sqlite'}, proposal, 'Next', p, undefined, intent));
  expect(admitted.plan.stages.map(s=>s.id)).toEqual(expectedStages);
  expect(planStageStates(p.stageStates, admitted).find(s=>s.stage==='work')?.state).toBe(expectedState);
});

it('cancelled lifecycle stops scheduling', () => {
  expect(decideNext({...coreProjection(),status:'cancelled'})).toMatchObject({ok:true,value:{kind:'stop',conclusion:{status:'cancelled',reason:'cancelled'}}});
});

// The reducer reads lifecycle/conclusion and open obligations. All rows share
// the same settled history; obligation park reasons are outputs, not inputs.
it.each([
  [{status:'parked',reason:'backstop'}, null, 'backstop', true, 0, 1],
  [{status:'parked',reason:'recovery_unknown'}, null, 'recovery_unknown', true, 4, 0],
  [null, 'closure-unconfirmed', 'closure_unconfirmed', false, 4, 0],
  [null, 'claim-unreleased', 'claim_unreleased', false, 4, 0],
] as const)('resume journal: conclusion=%j obligation=%s → reason=%s admitted=%s suffix=%s segment=%s',
 async (conclusion, obligation, reason, allowed, suffix, segment) => {
  const f = await sqlFixture();
  try {
    await f.admit();
    for (let n=1;n<=4;n++) {
      const raw={...receipt(coreProjection()),address:{run:'Run',stage:'work',attempt:'Failure'+n,invocation:1},
        ending:'invalid_answer' as const,audit:f.ref};
      await f.append(f.execution,[
        {type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...raw.address}}},
        {type:'attempt_settled',receipt:raw},
        {type:'outcome_settled',address:raw.address,obligation:'Revision:0',completed:false,
          backstop:{gateSuffix:0,failureSuffix:n,bestPassCount:null,segment:0,settlement:JSON.stringify(raw.address),obligation:'Revision:0'}},
      ]);
    }
    if (obligation) await f.append(f.control,[{type:'obligation',open:true,obligation:{kind:obligation,detail:'Unresolved owner',members:[]}}]);
    if (conclusion) await f.append(f.execution,[{type:'lifecycle',conclusion:{...conclusion,detail:'Retained stop'}}]);
    const before=await f.projection();
    expect(before).toMatchObject({status:'parked',conclusion:{reason},obligations:obligation?[expect.objectContaining({kind:obligation})]:[]});
    const resume = async () => appendEvents(f.control,null,[{type:'control_intent',intent:{
      id:'Resume',kind:'resume',run:'Run',unit:f.launch.unit,expectedCursor:(await f.projection()).cursor}}]);
    expect((await resume()).ok).toBe(allowed);
    expect((await f.projection()).backstop).toMatchObject({failureSuffix:suffix,segment});
    if (obligation) {
      expect(await f.projection()).toEqual(before);
      await f.append(f.control,[{type:'obligation',open:false,obligation:before.obligations[0]}]);
      get(await resume());
      expect((await f.projection()).backstop).toEqual(before.backstop);
    }
    expect((await f.projection()).status).toBe('pending');
  } finally { await f.close(); }
});

function receipt(p: RunProjection): AttemptReceipt {
  return {address:{run:p.run,stage:'work',attempt:'Prior',invocation:1},ending:'delivered',closure:'dead',
    before:'b'.repeat(64),after:'c'.repeat(64),audit:p.brief.bytes,evidence:[],usage:{state:'unknown',raw:[]},inputChars:1};
}

// Address equality, settlement and retirement are the only raw-selection inputs.
it.each([
  [null, false, true], [1, false, false], [null, true, false], [2, false, true],
] as const)('raw settlement: settledInvocation=%s skipped=%s → pending=%s', (settledInvocation, skipped, pending) => {
  const p=coreProjection(), raw=receipt(p);
  p.received=[raw];
  p.attempts=settledInvocation === null ? [] : [{...raw,address:{...raw.address,invocation:settledInvocation}}];
  if(skipped) p.stageStates=p.stageStates.map(s=>s.stage==='work'?{...s,state:'skipped'}:s);
  expect(pendingReceipts(p)).toEqual(pending?[raw]:[]);
});
it.each([
  ['dead', false, false], ['unknown', false, true], ['unknown', true, false],
] as const)('attempt ownership: closure=%s reconciled=%s → open=%s', (closure, reconciled, open) => {
  const p=coreProjection(), raw={...receipt(p),closure};
  if(reconciled) p.closedInvocations=[{charge:'work',address:{kind:'stage',...raw.address}}];
  expect(attemptOpen(p,raw)).toBe(open);
});

it.each(['invalid_plan','invalid_answer'] as const)('C2 ending=%s failure disposition is a settled outcome', ending => {
  const p=coreProjection(), raw={...receipt(p),ending};
  p.backstop.failureSuffix=3;
  const facts=outcomeFacts(p,raw,p.stageStates[0],false);
  expect(facts).toMatchObject([{type:'outcome_settled',completed:false,backstop:{failureSuffix:4}},
    {type:'lifecycle',conclusion:{status:'parked',reason:'backstop'}}]);
  expect(decideRetry({projection:p,receipt:raw})).toEqual({kind:'retry',charge:'correction'});
});
it.each([
  ['provider_unknown','dead', 'park'],
  ['closure_unknown','unknown','park'],
  ['delivered','dead','settled'],
] as const)('retry ending=%s closure=%s → %s', (ending,closure,kind) => {
  const p=coreProjection(), raw={...receipt(p),ending,closure};
  expect(decideRetry({projection:p,receipt:raw})).toMatchObject({kind});
});
it.each([
  ['pending',true,'pending','cancelled'],['running',true,'running','cancelled'],['parked',true,'pending','cancelled'],
  ['complete',false,null,'completed'],['accepted_blocked',false,null,'completed'],['incomplete',false,null,'failed'],['failed',false,null,'failed'],['escalated',false,null,'failed'],['cancelled',false,null,'cancelled'],
] as const)('control lifecycle %s → guidance=%s resume=%s cancel=%s', (status,guidance,resume,cancel) => {
  expect(acceptsGuidance(status,false)).toBe(guidance);
  expect(acceptsGuidance(status,true)).toBe(false);
  expect(nextLifecycle(status,'resume')).toBe(resume);
  expect(nextLifecycle(status,'cancel')).toBe(cancel);
});
