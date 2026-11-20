import { expect, it } from 'vitest';
import { initialBackstop, type AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { reduceOutcome, outcomeFacts } from '../dist-rewrite/core/retry.js';
import { decideNext, decidePublication } from '../dist-rewrite/core/decisions.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';

type Event = Parameters<typeof reduceOutcome>[1];
const failure = (obligation = 'work'): Event => ({settlement:'failed',obligation,failed:true,firstCompletion:false});
const completion = (obligation = 'work', firstCompletion = true): Event =>
  ({settlement:'completed',obligation,failed:false,firstCompletion});
const rejection = (passCount: number, failed = false): Event =>
  ({settlement:'gate',obligation:'gate',failed,firstCompletion:false,gate:{accepted:false,passCount}});
// Every expected row is authored here, independently of the reducer.
it.each([
  ['record high, lower, equal', [rejection(2),rejection(4),rejection(3),rejection(4)],
    [[1,0,2],[1,0,4],[2,0,4],[3,0,4]]],
  ['repeated completion is not new progress', [failure(),completion(),rejection(0),failure(),completion('work',false),rejection(1),
    failure(),completion('work',false),rejection(2),failure(),completion('work',false),rejection(3),failure()],
    [[0,1,null],[0,0,null],[1,0,0],[1,1,0],[1,1,0],[1,1,1],[1,2,1],[1,2,1],[1,2,2],[1,3,2],[1,3,2],[1,3,3],[1,4,3]]],
  ['independent first completions', [failure('b'),completion('b'),failure('a'),completion('a')],
    [[0,1,null],[0,0,null],[0,1,null],[0,0,null]]],
  ['one failed rejection updates both counters once', [rejection(0,true),rejection(0,true),rejection(0,true)],
    [[1,1,0],[2,2,0],[3,3,0]]],
  ['repair completions preserve rejection high water', [failure(),completion(),rejection(4),completion('planner'),
    failure('repair1'),completion('repair1'),rejection(3),completion('planner',false),failure('repair2'),completion('repair2'),rejection(4)],
    [[0,1,null],[0,0,null],[1,0,4],[1,0,4],[1,1,4],[1,0,4],[2,0,4],[2,0,4],[2,1,4],[2,0,4],[3,0,4]]],
  ['a real pass clears both suffixes and high water', [rejection(2),failure(),
    {...completion('progress'),gate:{accepted:true,passCount:3}},rejection(0),rejection(0),rejection(0)],
    [[1,0,2],[1,1,2],[0,0,null],[1,0,0],[2,0,0],[3,0,0]]],
] as Array<[string,Event[],Array<[number,number,number|null]>]>)('%s', (_name,events,expected) => {
  let state = initialBackstop();
  const actual = events.map(event => {
    state = reduceOutcome(state,event);
    expect(state).toMatchObject({settlement:event.settlement,obligation:event.obligation,segment:0});
    return [state.gateSuffix,state.failureSuffix,state.bestPassCount];
  });
  expect(actual).toEqual(expected);
});

function gateReceipt(ending: AttemptReceipt['ending'], outcome: 'accepted'|'accepted_blocked'|'rejected_repairable'|'rejected_irreparable',
  passing = ['a','b']): AttemptReceipt {
  const p = coreProjection(true), receipt = p.attempts[0];
  return {...receipt,ending,answer:{kind:'gate',answer:{outcome,reason:'Opaque diagnostic -999',
    criteria:Object.fromEntries(['a','b','c'].map(id=>[id,{status:passing.includes(id)?'pass':'fail',evidence:'Independent predicate'}])),
    findings:[],remainingWork:[]}}};
}
it('equal counts on different predicates do not union into progress', () => {
  let backstop = initialBackstop();
  for (const passing of [['a','b'],['b','c'],['a','c']]) {
    const p = {...coreProjection(),backstop};
    const facts = outcomeFacts(p,gateReceipt('delivered','rejected_repairable',passing),p.stageStates[1],false,true);
    expect(facts[0].type).toBe('outcome_settled');
    if (facts[0].type !== 'outcome_settled') throw Error('Missing settlement');
    backstop = facts[0].backstop;
  }
  expect(backstop).toMatchObject({gateSuffix:3,failureSuffix:0,bestPassCount:2});
});
it.each(['provider_unknown','quota','duration','input_too_large'] as const)('unaccepted %s keeps partial rejection ineffective', ending => {
  const p = coreProjection(), receipt = gateReceipt(ending,'rejected_irreparable');
  expect(outcomeFacts(p,receipt,p.stageStates[1],false,true)).toEqual([{type:'outcome_settled',address:receipt.address,
    obligation:p.stageStates[1].obligation,completed:false,backstop:{...initialBackstop(),settlement:JSON.stringify(receipt.address),
      obligation:p.stageStates[1].obligation}}]);
});
it.each(['delivered','technical_failure'] as const)('irreparable refusal wins over C2 with %s', ending => {
  const p = {...coreProjection(),backstop:{...initialBackstop(),gateSuffix:2,bestPassCount:2}};
  const facts = outcomeFacts(p,gateReceipt(ending,'rejected_irreparable'),p.stageStates[1],false,true);
  expect(facts).toMatchObject([{type:'outcome_settled',completed:false,backstop:{gateSuffix:3,
    failureSuffix:ending==='technical_failure'?1:0,bestPassCount:2}},
    {type:'lifecycle',conclusion:{status:'failed',reason:'gate_irreparable'}}]);
  expect(facts).toHaveLength(2);
});
it.each([
  ['accepted','complete','completed'],['accepted_blocked','accepted_blocked','accepted_blocked'],
  ['rejected_irreparable','failed','gate_irreparable']
] as const)('routes the typed %s independently of diagnostic prose', async (outcome,status,reason) => {
  const base = coreProjection(true), receipt = base.attempts[0];
  if (receipt.answer?.kind !== 'gate') throw Error('Missing authored gate');
  const changed = {...receipt,answer:{kind:'gate' as const,answer:{...receipt.answer.answer,outcome,reason:'Opaque diagnostic -999'}}};
  const p = {...base,brief:{...base.brief,declaration:{...base.brief.declaration,allowBlocked:true}},attempts:[changed],transitions:[]};
  const next = decideNext(p);
  expect(next).toMatchObject({ok:true,value:{kind:'transition',transition:{outcome,next:null}}});
  if (!next.ok || next.value.kind!=='transition') throw Error('Missing transition');
  const applied = {...p,transitions:[next.value.transition]};
  if (outcome==='rejected_irreparable') expect(decideNext(applied)).toMatchObject({ok:true,value:{kind:'stop',conclusion:{status,reason}}});
  else expect(await decidePublication({root:'/synthetic',database:'/synthetic/state.sqlite'},applied,p.checkpoints[0],{preserved:true,artifacts:[],detail:''}))
    .toMatchObject({ok:true,value:{status,reason}});
});

it.each([
  ['gate', {gateSuffix:2,failureSuffix:0,bestPassCount:2}, 3, 0],
  ['failure', {gateSuffix:0,failureSuffix:3,bestPassCount:null}, 0, 4],
] as const)('parks exactly at the %s suffix threshold', (condition,before,gateSuffix,failureSuffix) => {
  const p = {...coreProjection(),backstop:{...initialBackstop(),...before}};
  const receipt = condition==='gate'?gateReceipt('delivered','rejected_repairable'):
    {...gateReceipt('technical_failure','rejected_repairable'),answer:undefined,answerRef:undefined};
  const facts = outcomeFacts(p,receipt,p.stageStates[condition==='gate'?1:0],false,condition==='gate');
  expect(facts).toHaveLength(2);
  expect(facts).toMatchObject([{type:'outcome_settled',completed:false,backstop:{gateSuffix,failureSuffix}},
    {type:'lifecycle',conclusion:{status:'parked',reason:'backstop'}}]);
});
it.each(['accepted','accepted_blocked'] as const)('first effective %s completes once and clears both suffixes', outcome => {
  const p = {...coreProjection(),backstop:{...initialBackstop(),gateSuffix:2,failureSuffix:3,bestPassCount:2}};
  const receipt = gateReceipt('delivered',outcome);
  expect(outcomeFacts(p,receipt,p.stageStates[1],true)).toEqual([{type:'outcome_settled',address:receipt.address,
    obligation:p.stageStates[1].obligation,completed:true,backstop:{...initialBackstop(),settlement:JSON.stringify(receipt.address),
      obligation:p.stageStates[1].obligation}}]);
});

it.each([
  ['delivered',0],['invalid_answer',1],['invalid_plan',1],['work_failed',1],['technical_failure',1],
  ['auth',0],['refused',0],['input_too_large',0],['quota',0],['duration',0],['cancelled',0],
  ['isolation_failure',1],['closure_unknown',0],['provider_unknown',0]
] as const)('classifies C2 failure contribution for %s', (ending,failureSuffix) => {
  const p = coreProjection(), receipt = {...gateReceipt(ending,'rejected_repairable'),answer:undefined,answerRef:undefined};
  expect(outcomeFacts(p,receipt,p.stageStates[0],false)).toEqual([{type:'outcome_settled',address:receipt.address,
    obligation:p.stageStates[0].obligation,completed:false,backstop:{...initialBackstop(),failureSuffix,
      settlement:JSON.stringify(receipt.address),obligation:p.stageStates[0].obligation}}]);
});

it.each([
  ['work',false,true,0],['work',true,false,3],['plan',false,true,0],['plan',true,false,3]
] as const)('allocates %s first completion from the obligation completed=%s', (purpose,completed,expectedCompletion,failureSuffix) => {
  const p = {...coreProjection(),backstop:{...initialBackstop(),gateSuffix:2,failureSuffix:3,bestPassCount:4}};
  const stage = {stage:'Step',obligation:'Revision:shared',state:'settled' as const,completed};
  const receipt: AttemptReceipt = {...gateReceipt('delivered','accepted'),address:{run:'Run',stage:'Step',attempt:'NextVisit',invocation:1},
    answer:purpose==='plan'?{kind:'plan',answer:{baseRevision:p.plan.revision,plan:p.plan.plan}}:{kind:'work',answer:{
      status:'delivered',summary:'Usable work',caveats:[],remainingWork:[],blocks:null}}};
  expect(outcomeFacts(p,receipt,stage,true)).toEqual([{type:'outcome_settled',address:receipt.address,obligation:'Revision:shared',
    completed:expectedCompletion,backstop:{...initialBackstop(),gateSuffix:2,failureSuffix,bestPassCount:4,
      settlement:JSON.stringify(receipt.address),obligation:'Revision:shared'}}]);
});
